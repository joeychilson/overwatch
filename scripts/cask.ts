/**
 * Write the tap's two descriptions of a release.
 *
 * Homebrew reads the Ruby cask. Anything that installs a tapped cask without
 * Homebrew reads the same facts as JSON, at the path the official API serves
 * it from: mise, which is one such thing, fetches
 * `<tap>/HEAD/api/cask/<token>.json` and nothing else. A tap that publishes
 * only the Ruby leaves those installers on whatever version they last saw, so
 * both are written here, from one set of facts, by one run.
 *
 * What the app is comes from `tauri.conf.json` and `package.json`, so a
 * renamed app or a raised system requirement reaches the tap without anyone
 * remembering to copy it. What the release is — the file and its digest — is
 * given on the command line, since only the build knows it.
 *
 * Run by the release workflow:
 * `node scripts/cask.ts --sha256 <digest> --asset <file> --repo <owner/name> --out <dir>`
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The macOS releases Homebrew knows by name, which is how a cask names them. */
const NAMED: Record<string, string> = {
  "13": "ventura",
  "14": "sonoma",
  "15": "sequoia",
  "26": "tahoe",
};

function argument(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : process.argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing --${name}`);
  return value;
}

const sha256 = argument("sha256");
const asset = argument("asset");
const repo = argument("repo");
const out = argument("out");

const tauri = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8")) as {
  productName: string;
  version: string;
  identifier: string;
  bundle: { macOS: { minimumSystemVersion: string } };
};
const pkg = JSON.parse(await readFile("package.json", "utf8")) as { description: string };

const { productName, version, identifier } = tauri;
const token = productName.toLowerCase();
// A cask's description is a noun phrase rather than a sentence, and Homebrew's
// own audit rejects the full stop this project's description ends with.
const desc = pkg.description.replace(/\.$/, "");
const [owner] = repo.split("/");
const tap = `${owner}/tap`;
const homepage = `https://github.com/${repo}`;
const url = `${homepage}/releases/download/v${version}/${asset}`;
// The version is written back into the address as the cask's own reference, so
// the file it fetches follows the version above rather than repeating it.
const templated = url.replaceAll(version, "#{version}");

const major = tauri.bundle.macOS.minimumSystemVersion.split(".")[0] ?? "";
const named = NAMED[major];
if (named === undefined) {
  throw new Error(`No Homebrew name for macOS ${major}; add it to NAMED in scripts/cask.ts`);
}

/** Where the app keeps what it has read, which is what uninstalling clears. */
const zap = [
  `~/Library/Application Support/${identifier}`,
  `~/Library/Caches/${identifier}`,
  `~/Library/Saved Application State/${identifier}.savedState`,
];

const ruby = `cask "${token}" do
  version "${version}"
  sha256 "${sha256}"

  url "${templated}"
  name "${productName}"
  desc "${desc}"
  homepage "${homepage}"

  # Releases are tags, so the newest one is what Homebrew should compare with.
  livecheck do
    url :url
    strategy :github_latest
  end

  # Not notarized, so Gatekeeper stops a downloaded copy unless it arrives
  # without the quarantine flag: install with \`--no-quarantine\`.
  depends_on macos: ">= :${named}"

  app "${productName}.app"

  zap trash: [
${zap.map((path) => `    "${path}",`).join("\n")}
  ]
end
`;

/**
 * The same cask as the Homebrew API serves it.
 *
 * The fields an installer reads are the address, the digest, the version and
 * the artifacts; the rest are carried because the API carries them, and
 * something that mirrors the shape is likelier to keep working than something
 * that holds only what one reader needs today.
 */
const json = {
  token,
  full_token: `${tap}/${token}`,
  old_tokens: [],
  tap,
  name: [productName],
  desc,
  homepage,
  url,
  url_specs: {},
  version,
  installed: null,
  installed_time: null,
  bundle_version: null,
  bundle_short_version: null,
  outdated: false,
  sha256,
  artifacts: [
    { app: [`${productName}.app`], target: `/Applications/${productName}.app` },
    { zap: [{ trash: zap }] },
  ],
  caveats: null,
  depends_on: { macos: { ">=": [major] } },
  conflicts_with: null,
  container: null,
  auto_updates: false,
  deprecated: false,
  disabled: false,
  languages: [],
  variations: {},
};

await mkdir(join(out, "Casks"), { recursive: true });
await mkdir(join(out, "api", "cask"), { recursive: true });
await writeFile(join(out, "Casks", `${token}.rb`), ruby);
await writeFile(join(out, "api", "cask", `${token}.json`), `${JSON.stringify(json, null, 2)}\n`);
console.log(`Wrote ${token} ${version} for ${tap}: Casks/${token}.rb, api/cask/${token}.json`);
