// Build an extension in a fresh Bun process and capture resolution observations.

import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, JSONC, resolveSync, Transpiler } from "bun";
import { type BundleRequest, type BundleResult, type Observation, readObservation } from "./extension-observations.ts";

interface TsConfig {
	extends?: string | string[];
	compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

async function bundleExtension(request: BundleRequest): Promise<BundleResult> {
	const external = new Set(request.external);
	const observations = new Map<string, Observation>();
	const metadataDirectories = new Set<string>();
	const configs = new Map<string, TsConfig>();
	const observe = (kind: Observation["kind"], filename: string) => {
		const key = `${kind}:${filename}`;
		if (!observations.has(key))
			observations.set(key, {
				kind,
				filename,
				value: readObservation({ kind, filename }),
			});
	};
	const observeCandidate = (filename: string) => {
		observe("directory", dirname(filename));
		observe("directory", filename);
		observe("package", join(filename, "package.json"));
	};
	const observePackage = (specifier: string, from: string) => {
		const parts = specifier.split("/");
		const packageName = parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
		for (let current = from; ; current = dirname(current)) {
			const root = join(current, "node_modules", packageName);
			observe("directory", root);
			observe("package", join(root, "package.json"));
			if (specifier !== packageName) observeCandidate(join(current, "node_modules", specifier));
			if (current === dirname(current)) break;
		}
	};
	const observeConfig = (filename: string) => {
		observe("config", filename);
		if (configs.has(filename) || !existsSync(filename)) return;
		const config = JSONC.parse(readFileSync(filename, "utf8")) as TsConfig;
		configs.set(filename, config);
		for (const base of config.extends === undefined
			? []
			: typeof config.extends === "string"
				? [config.extends]
				: config.extends) {
			let inherited: string;
			if (base.startsWith(".") || isAbsolute(base)) {
				inherited = resolve(dirname(filename), base);
				if (!inherited.endsWith(".json")) inherited += ".json";
			} else {
				observePackage(base, dirname(filename));
				try {
					inherited = resolveSync(base, dirname(filename));
				} catch {
					try {
						inherited = resolveSync(`${base}/tsconfig.json`, dirname(filename));
					} catch {
						// Published JS dependencies may omit the development config they extend.
						continue;
					}
				}
			}
			observeConfig(inherited);
		}
	};
	const observeMetadata = (filename: string) => {
		observe("directory", dirname(filename));
		for (let current = dirname(filename); ; current = dirname(current)) {
			if (metadataDirectories.has(current)) break;
			metadataDirectories.add(current);
			observe("package", join(current, "package.json"));
			observeConfig(join(current, "tsconfig.json"));
			if (current === dirname(current)) break;
		}
	};
	const result = await build({
		entrypoints: [request.filename],
		target: "node",
		format: "esm",
		minify: true,
		throw: false,
		plugins: [
			{
				name: "extension-paths",
				setup(builder) {
					builder.onResolve({ filter: /.*/ }, (args) => {
						if (isBuiltin(args.path) || external.has(args.path)) return { path: args.path, external: true };
						if (args.path.startsWith("file:")) observeCandidate(fileURLToPath(args.path));
						else if (args.path.startsWith(".") || isAbsolute(args.path))
							observeCandidate(resolve(args.resolveDir, args.path));
						else {
							observePackage(args.path, args.resolveDir);
							// Include unused path targets so adding an earlier candidate is visible.
							const bases = [...configs].map(([filename, config]) =>
								resolve(dirname(filename), config.compilerOptions?.baseUrl ?? "."),
							);
							for (const [filename, config] of configs) {
								if (config.compilerOptions?.baseUrl)
									observeCandidate(resolve(dirname(filename), config.compilerOptions.baseUrl, args.path));
								for (const [pattern, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
									const star = pattern.indexOf("*");
									if (
										star < 0
											? pattern !== args.path
											: !args.path.startsWith(pattern.slice(0, star)) ||
												!args.path.endsWith(pattern.slice(star + 1))
									)
										continue;
									const match =
										star < 0 ? "" : args.path.slice(star, args.path.length - (pattern.length - star - 1));
									for (const target of targets)
										for (const base of bases) observeCandidate(resolve(base, target.replace("*", match)));
								}
							}
						}
						if (args.path.endsWith(".node"))
							return {
								path: resolve(args.resolveDir, args.path),
								external: true,
							};
					});
					builder.onLoad({ filter: /.*/ }, (args) => {
						const filename = resolve(args.path);
						const contents = readFileSync(filename);
						observeMetadata(filename);
						// Hash the exact bytes passed to the compiler; a second read could race an edit.
						observations.set(`input:${filename}`, {
							kind: "input",
							filename,
							value: readObservation({ kind: "input", filename }, contents),
						});
						if (/\.[cm]?[jt]sx?$/.test(filename)) {
							const extension = extname(filename);
							const loader =
								extension === ".tsx"
									? "tsx"
									: extension === ".jsx"
										? "jsx"
										: /\.[cm]?ts$/.test(filename)
											? "ts"
											: "js";
							const transpiler = new Transpiler({
								loader,
								trimUnusedImports: true,
								define: {
									"import.meta.url": JSON.stringify(pathToFileURL(filename).href),
									"import.meta.dirname": JSON.stringify(dirname(filename)),
									"import.meta.filename": JSON.stringify(filename),
									__dirname: JSON.stringify(dirname(filename)),
									__filename: JSON.stringify(filename),
								},
							});
							return {
								contents: transpiler.transformSync(contents.toString("utf8")),
								loader: "js",
							};
						}
						if (filename.endsWith(".json"))
							return {
								contents: contents.toString("utf8"),
								loader: "json",
							};
					});
				},
			},
		],
	});
	if (!result.success)
		return {
			status: "failed",
			reason: result.logs.map((log) => log.message).join("\n"),
		};
	if (result.outputs.length !== 1)
		return {
			status: "failed",
			reason: "The extension bundle produced multiple outputs",
		};
	const changed = [...observations.values()].find((observation) => readObservation(observation) !== observation.value);
	if (changed)
		return {
			status: "failed",
			reason: `An input changed during compilation: ${changed.filename}`,
		};
	return {
		status: "built",
		source: await result.outputs[0].text(),
		observations: [...observations.values()],
	};
}

const request = JSON.parse(await Bun.stdin.text()) as BundleRequest;
console.log(JSON.stringify(await bundleExtension(request)));
