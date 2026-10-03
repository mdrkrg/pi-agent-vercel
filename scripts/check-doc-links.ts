import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { lexer, walkTokens } from "marked";

export type LinkIssue = { readonly document: string; readonly href: string; readonly reason: string };

/** Check local Markdown link/image paths, not remote URLs, fragments, or embedded HTML. */
export function checkDocumentLinks(root: string): { documents: number; links: number; issues: LinkIssue[] } {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const tracked = new Set(files);
  const documents = files.filter((file) => /\.md$/i.test(file));
  const issues: LinkIssue[] = [];
  let links = 0;
  for (const document of documents) {
    let source: string;
    try { source = readFileSync(resolve(root, document), "utf8"); }
    catch { issues.push({ document, href: "", reason: "Cannot read tracked document" }); continue; }
    walkTokens(lexer(source), (token) => {
      if (token.type !== "link" && token.type !== "image") return;
      const href = token.href;
      if (href === "" || href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
      links++;
      const fail = (reason: string) => { issues.push({ document, href, reason }); };
      let path: string;
      try { path = decodeURIComponent(href.split(/[?#]/, 1)[0]!); }
      catch { fail("Invalid URL encoding"); return; }
      const target = path.startsWith("/") ? resolve(root, `.${path}`) : resolve(dirname(resolve(root, document)), path);
      const local = relative(root, target);
      if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
        fail("Target is outside the repository"); return;
      }
      const gitPath = local.split(sep).join("/");
      try {
        const stat = statSync(target);
        const included = stat.isDirectory()
          ? files.some((file) => gitPath === "" || file.startsWith(`${gitPath}/`))
          : stat.isFile() && tracked.has(gitPath);
        if (!included) fail("Target is not tracked by Git");
      } catch { fail("Target does not exist"); }
    });
  }
  return { documents: documents.length, links, issues };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const result = checkDocumentLinks(root);
    for (const issue of result.issues) console.error(`${issue.document}: ${issue.href || "(document)"}: ${issue.reason}`);
    if (result.issues.length > 0) process.exitCode = 1;
    else console.log(`Checked ${result.documents} Markdown documents and ${result.links} local links.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Documentation link check failed");
    process.exitCode = 1;
  }
}
