// Build the official Bun entry with content-validated extension precompilation.

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "bun";
import { injectPackageHooks, replaceOnce } from "./package-hooks.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const packageRoot = join(root, "packages/coding-agent");
const assetDirectory = process.argv[2];
if (!assetDirectory) throw new Error("Provide the current npm pi package directory to copy binary assets");
const output = join(root, "build/startup-precompile/binaries");
await mkdir(output, { recursive: true });
const outfile = join(output, "pi-precompiled.exe");
const compilerPath = fileURLToPath(new URL("./extension-cache.ts", import.meta.url));
const installedModule = fileURLToPath(new URL("./installed-extensions.ts", import.meta.url));
const compilerBuild = await build({
	entrypoints: [fileURLToPath(new URL("./extension-bundle.ts", import.meta.url))],
	target: "bun",
	format: "esm",
	minify: true,
});
const compilerSource = await compilerBuild.outputs[0].text();
const result = await build({
	entrypoints: [
		join(packageRoot, "src/bun/cli.ts"),
		join(packageRoot, "src/utils/image-resize-worker.ts"),
		join(packageRoot, "src/extensions/codemode/worker.ts"),
	],
	root: packageRoot,
	target: "bun",
	compile: {
		target: "bun-windows-x64-baseline",
		outfile,
		executablePath: process.execPath,
		autoloadDotenv: false,
		autoloadBunfig: false,
		autoloadPackageJson: true,
	},
	plugins: [
		{
			name: "startup-precompile",
			setup(builder) {
				builder.onLoad({ filter: /[\\/]startup-precompile[\\/]extension-cache\.ts$/ }, async (args) => {
					let source = await readFile(args.path, "utf8");
					const start = source.indexOf("const compilerBuild =");
					const end = source.indexOf("\nconst version =", start);
					if (start < 0 || end < 0) throw new Error("Extension compiler structure changed");
					source =
						source.slice(0, start) +
						`const compilerSource = ${JSON.stringify(compilerSource)};` +
						source.slice(end);
					return {
						contents: source,
						loader: "ts",
						resolveDir: dirname(args.path),
					};
				});
				builder.onLoad({ filter: /[\\/]core[\\/]extensions[\\/]loader\.ts$/ }, async (args) => {
					let source = await readFile(args.path, "utf8");
					source = `import { prepareCompiledExtension } from ${JSON.stringify(compilerPath)};\nimport { selectedInstallRoot } from ${JSON.stringify(installedModule)};\n${source}`;
					source = source.replace(
						"const jiti = createJitiImpl(import.meta.url, {",
						'const compilerJiti = createJitiImpl(import.meta.url, { moduleCache: false, fsCache: false, ...resolutionOptions });\n\tconst compiled = await prepareCompiledExtension(canonicalizePath(extensionPath), resolutionOptions.virtualModules ?? {}, compilerJiti, path.join(getAgentDir(), "cache", "extensions-prototype"), pathsEqual(canonicalizePath(extensionPath), extensionPath) ? selectedInstallRoot(extensionPath) : undefined);\n\tconst jiti = createJitiImpl(import.meta.url, {',
					);
					source = source.replace(
						"moduleCache: false,\n\t\t...resolutionOptions,",
						"moduleCache: false,\n\t\t...resolutionOptions,\n\t\t...(compiled ? { fsCache: false, transform: (options: { source: string }) => ({ code: options.source }) } : {}),",
					);
					source = source.replace(
						"const module = await jiti.import(canonicalizePath(extensionPath), { default: true });",
						'const loadedModule = compiled ? await jiti.evalModule(compiled, { filename: canonicalizePath(extensionPath), ext: ".cjs", async: true, forceTranspile: true }) : await jiti.import(canonicalizePath(extensionPath), { default: true });\n\tconst module = (loadedModule as { default?: unknown } | undefined)?.default ?? loadedModule;',
					);
					if (
						!source.includes("const compiled = await prepareCompiledExtension(") ||
						!source.includes("const loadedModule = compiled ?")
					) {
						throw new Error("Extension loader structure changed; update the experimental build injection points");
					}
					source += `
/** Precompile installed entries without executing extension factories. */
export async function precompileInstalledExtensions(files: Map<string, string | undefined>, cache: string): Promise<void> {
	if (!files.size) return;
	const createJitiImpl = await getCreateJiti();
	const virtualModules = await getVirtualModules();
	const compiler = createJitiImpl(import.meta.url, { virtualModules, tryNative: false, moduleCache: false, fsCache: false });
	for (const [filename, root] of files) await prepareCompiledExtension(canonicalizePath(filename), virtualModules, compiler, cache, root);
}
`;
					return {
						contents: source,
						loader: "ts",
						resolveDir: dirname(args.path),
					};
				});
				builder.onLoad({ filter: /[\\/]core[\\/]resource-loader\.ts$/ }, async (args) => {
					let source = await readFile(args.path, "utf8");
					source = `import { withInstalledExtensions } from ${JSON.stringify(installedModule)};\n${source}`;
					const bootstrap = "await loadExtensionsCached(extensionPaths, this.cwd, this.eventBus)";
					source = replaceOnce(
						source,
						bootstrap,
						"await withInstalledExtensions(metadataByPath, () => loadExtensionsCached(extensionPaths, this.cwd, this.eventBus))",
					);
					const finalLoad = "await this.loadFinalExtensionSet(extensionPaths, preTrustExtensions)";
					source = replaceOnce(
						source,
						finalLoad,
						"await withInstalledExtensions(metadataByPath, () => this.loadFinalExtensionSet(extensionPaths, preTrustExtensions))",
					);
					return { contents: source, loader: "ts", resolveDir: dirname(args.path) };
				});
				builder.onLoad({ filter: /[\\/]core[\\/]package-manager\.ts$/ }, async (args) => ({
					contents: injectPackageHooks(await readFile(args.path, "utf8"), installedModule),
					loader: "ts",
					resolveDir: dirname(args.path),
				}));
			},
		},
	],
});
if (!result.success) throw new AggregateError(result.logs, "Experimental binary build failed");
for (const name of ["assets", "theme", "export-html", "native", "photon_rs_bg.wasm", "README.md"]) {
	await cp(join(resolve(assetDirectory), name), join(output, name), {
		recursive: true,
	});
}
await cp(join(packageRoot, "package.json"), join(output, "package.json"));
const binary = await readFile(outfile);
const manifest = {
	outfile,
	bytes: binary.length,
	sha256: createHash("sha256").update(binary).digest("hex"),
};
await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
