# Postgres backend agent-loop load evaluation

源码预估使用 Pi checkout（commit `4259686d9`）；运行时依赖为仓库锁定的 `@earendil-works/pi-agent-core@0.87.1`。

## 术语说明

- **Session**：一个持久化会话，包含 conversation entries、当前 branch、运行状态和 usage。一次 benchmark 场景会创建一个或多个 session。
- **Operation**：session 中一次可恢复的工作单元。一次用户 prompt 会先创建 operation，然后由 worker 推进到完成、等待或失败。
- **Admission**：接收 prompt 的阶段。它把用户输入和 operation 初始状态写入数据库，但不一定立即执行模型调用。
- **Drive**：推进一个已接收 operation 的执行阶段。worker 读取当前 durable state，执行下一步模型或工具动作，再提交新的状态；如果 operation 尚未结束，下一次 drive 会继续推进它。这里的 drive 可以理解为“一次可重试的执行 pass”，不是数据库驱动器。
- **Storage commit**：一次 session storage 原子事务。它可以同时写 entry、value、list、usage 和 operation state；一个 commit 通常会展开成多条 PostgreSQL SQL。
- **Entry**：conversation 中的一条不可变记录，例如 user message、assistant message 或 tool result。
- **Branch tip**：当前 conversation 分支的最后一条 entry id。追加 entry 时通常同时更新它。
- **Lease**：session 的短期写入所有权。worker 只有持有有效 lease 才能提交状态；lease 用于阻止旧 worker 写入，不等于 operation state。
- **Faux provider**：测试用的确定性模型 provider。它返回预设响应，不访问真实模型服务，因此 benchmark 主要测数据库和 runtime 开销。
- **Warm / cold**：warm 表示同一 worker 继续持有进程内对象；cold 表示重新打开 session 或在新进程中恢复 durable state。

## 运行

可重复执行的基准在 [`benchmarks/postgres-agent-loop.ts`](../benchmarks/postgres-agent-loop.ts)。运行命令：

```sh
DATABASE_URL=postgresql://... POC_BENCH_ITERATIONS=10 POC_FAUX_TPS=10 \
  pnpm bench:postgres-agent-loop
```

如果本机没有 PostgreSQL，可以用 Podman 启动临时实例：

```sh
podman run --rm --name pi-agent-eval-pg \
  -e POSTGRES_USER=bench \
  -e POSTGRES_PASSWORD=bench \
  -e POSTGRES_DB=agent_eval \
  -p 127.0.0.1:55433:5432 \
  docker.io/library/postgres:18-alpine
```

另开终端等待 `pg_isready` 返回 accepting connections，然后设置：

```sh
export DATABASE_URL=postgresql://bench:bench@127.0.0.1:55433/agent_eval
```

测试百级并发时，使用 `POC_BENCH_CONCURRENCY` 和 `POC_BENCH_CONCURRENT_TURNS`：

```sh
DATABASE_URL=postgresql://bench:bench@127.0.0.1:55433/agent_eval \
POC_BENCH_CONCURRENCY=200 \
POC_BENCH_CONCURRENT_TURNS=3 \
POC_BENCH_POOL_MAX=90 \
POC_FAUX_TPS=10 \
pnpm bench:postgres-agent-loop
```

这套基准回答三个问题：一轮 agent loop 会访问数据库多少次、这些访问花多长时间，以及并发升高后 PostgreSQL 是否出现连接或事务瓶颈。

- **SQL 数量和类型**：记录每条 SQL、所属阶段、目标表、读写类型、耗时以及请求/响应大小。`SELECT`、`SHOW`、`EXPLAIN`、`VALUES` 计为读；`BEGIN`、`COMMIT`、`ROLLBACK`、`SET` 单独计为事务控制；其他语句计为写。
- **事务延迟**：记录每个 storage transaction 的持续时间、查询数、读写查询数和是否失败，用于观察单条 SQL 很快但事务整体变慢的情况。
- **Agent loop 阶段**：把访问归到 `admission`、`drive`、`setup`、`inspect`、`teardown`，从而区分业务执行开销和 session 生命周期开销。
- **PostgreSQL 统计**：运行前后读取 `pg_stat_database`，比较提交/回滚事务、磁盘块读取与命中、返回/获取的 tuple，以及插入、更新、删除数量。
- **连接活动**：每 25 ms 采样 `pg_stat_activity`，记录连接总数和 active 连接数，观察连接池是否达到上限。
- **CPU**：在容器环境中用宿主机 `podman top` 采样 PostgreSQL 进程 CPU；Podman cgroup 统计不可读时，这个数值是进程级近似值。

## 源码预估

源码阅读得到的预期负载如下：

- **一轮 prompt 会拆成多个 commit**。`Lane.command()` 每次只提交一个 mutation；`driveOperation()` 在 operation 尚未结束时继续执行后续 durable procedure。因此，一轮 user → assistant → tool 流程可能包含多次状态提交，而不是一次事务。
- **一次 commit 本身也会发出多条 SQL**。`PostgresStorage.commit()` 需要分配 sequence、校验 entry 和 parent、检查 lease、写入每个 `Write`，并更新消息数和 usage 统计。一个逻辑 commit 因此会展开成多条 SQL。
- **写入不只有 conversation entry**。除了 entry 和 branch tip，还可能写 operation state、usage、pending list、tool checkpoint 和 streaming frame。
- **读取主要来自状态查询和上下文构建**。`getValue()`、`getEntries()` 每次都会访问 PostgreSQL；`scanBranch()` 会沿 parent 链回溯历史，生成模型上下文前还会执行一次 branch scan。
- **当前 storage 没有跨调用的读缓存**。长 session 的 parent 链越长，上下文构建需要读取的 entry 越多；恢复路径还会额外读取 operation state、lane state 和 pending 数据。

因此评测同时关注两层指标：每个 prompt 的总 SQL/事务数量，以及单个 commit 内部的 SQL 数量和延迟。只统计写入行数会遗漏上下文读取、lease 校验和 stats 查询。

## 测试结果

当前实现使用 Podman PostgreSQL 18.4 Alpine、共享连接池上限 90、faux provider `POC_FAUX_TPS=10`。每个并发场景独立运行 3 轮；表中数值为算术平均值。每轮均为 0 failed sessions。

CPU 由宿主机 `podman top` 每 100 ms 采样容器内 PostgreSQL 进程的 `%CPU`，报告容器进程 CPU 总和的峰值和采样均值。Podman cgroup CPU 统计不可读，因此 CPU 数字是进程级近似值。

| 并发 session | 轮数 | SQL 总量 | 读 / 写 | 事务 | SQL p95 | 事务 p95 | SQL/s | CPU 峰值均值 | CPU 采样均值 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 1 | 11,700 | 6,600 / 5,100 | 1,300 | 17.7 ms | 696 ms | 3,880 | 98.8% | 53.9% |
| 200 | 1 | 23,400 | 13,200 / 10,200 | 2,600 | 85.5 ms | 2,192 ms | 3,298 | 84.2% | 34.9% |
| 100 | 3 | 33,500 | 20,000 / 13,500 | 3,300 | 7.6 ms | 153 ms | 4,757 | 114.9% | 74.1% |
| 200 | 3 | 67,000 | 40,000 / 27,000 | 6,600 | 97.8 ms | 471 ms | 5,085 | 126.2% | 68.5% |

三轮原始观测如下：

- 100×1：CPU 峰值 142.0%、81.2%、73.1%；事务 p95 497、612、980 ms。
- 200×1：CPU 峰值 89.5%、72.3%、90.9%；事务 p95 1,876、2,813、1,887 ms。
- 100×3：CPU 峰值 114.3%、113.8%、116.5%；事务 p95 108、230、122 ms。
- 200×3：CPU 峰值 145.6%、115.2%、117.8%；事务 p95 423、499、492 ms。

200×3 的 drive 阶段固定为 55,200 条 SQL、5,400 个事务，三轮均完成。200 session 场景的事务尾延迟明显高于 100 session；200×1 的三轮波动尤其大，说明连接池竞争和 PostgreSQL 调度会影响短场景的尾延迟。buffer hit ratio 为 100%，本轮主要压力来自事务/连接竞争和 SQL 数量，而不是磁盘读。

## 判断

普通 prompt 仍然是高频持久化路径：100×3 和 200×3 折算后都约为 111.7 SQL/session-turn，drive 阶段约 120 SQL/prompt。200×3 时 PostgreSQL 进程 CPU 峰值均值约 1.26 个 CPU 核，采样均值约 0.69 个 CPU 核，事务 p95 约 471 ms；这已经足以成为百级并发下的系统负载来源。

重测结果支持两个优化方向：减少每个 drive 的状态 commit/lease/stats SQL 数量，以及降低 branch/context 和 recovery 路径的重复读取。生产模型网络等待会降低单位时间 SQL 速率，但不会改变每个 prompt 的 SQL 工作量。长 transcript、真实工具输出、compaction、生产连接池配置仍需单独测量。
