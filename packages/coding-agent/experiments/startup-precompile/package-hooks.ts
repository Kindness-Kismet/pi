// Connect the experimental binary to the package manager's install roots and entry discovery.
export function replaceOnce(source: string, anchor: string, replacement: string): string {
	if (source.indexOf(anchor) < 0 || source.indexOf(anchor) !== source.lastIndexOf(anchor)) {
		throw new Error(`Unexpected experimental build injection point: ${anchor}`);
	}
	return source.replace(anchor, () => replacement);
}

export function injectPackageHooks(source: string, installedModule: string): string {
	source =
		'import { precompileInstalledExtensions } from "./extensions/loader.ts";\n' +
		"import { changeInstallation } from " +
		JSON.stringify(installedModule) +
		";\n" +
		source;
	const owner = "\n\t\t\t\tmetadata.packageRoot = installedPath;";
	if (source.split(owner).length !== 3) throw new Error("Unexpected installed package discovery structure");
	source = source.replaceAll(
		owner,
		`${owner}
				const target = this.precompileTarget(parsed, resolvedScope);
				if (target && pathsEqual(installedPath, target.path) && pathsEqual(canonicalizePath(installedPath), installedPath)) {
					metadata.precompileRoot = target.root;
				}`,
	);
	source = replaceOnce(
		source,
		"export interface PathMetadata {",
		"export interface PathMetadata {\n\tprecompileRoot?: string;",
	);
	const methods = `
	private precompileTarget(parsed: ParsedSource, scope: SourceScope): { path: string; root: string } | undefined {
		if (scope === "temporary" || parsed.type === "local") return undefined;
		if (parsed.type === "git") {
			const path = this.getGitInstallPath(parsed, scope);
			return { path, root: path };
		}
		return { path: this.getManagedNpmInstallPath(parsed, scope), root: join(this.getNpmInstallRoot(scope, false), "node_modules") };
	}

	private async withPrecompileChange(entries: { parsed: ParsedSource; scope: SourceScope }[], operation: () => Promise<void>): Promise<void> {
		const roots = new Map<string, Set<string>>();
		const localFiles = new Map<string, string | undefined>();
		for (const { parsed, scope } of entries) {
			if (parsed.type === "local" && scope !== "temporary") {
				const resources = this.createAccumulator();
				this.resolveLocalExtensionSource(parsed, resources, undefined, { source: parsed.path, scope, origin: "package" }, this.getBaseDirForScope(scope));
				for (const [file, resource] of resources.extensions) {
					if (resource.enabled) localFiles.set(file, undefined);
				}
				continue;
			}
			const target = this.precompileTarget(parsed, scope);
			if (!target) continue;
			const packages = roots.get(target.root) ?? new Set<string>();
			roots.set(target.root, packages);
			packages.add(target.path);
			if (parsed.type !== "npm") continue;
			const settings = scope === "user" ? this.settingsManager.getGlobalSettings() : this.settingsManager.getProjectSettings();
			for (const entry of settings.packages ?? []) {
				const other = this.parseSource(this.getPackageSourceString(entry));
				if (other.type === "npm") packages.add(this.getManagedNpmInstallPath(other, scope));
			}
		}
		const cache = join(this.agentDir, "cache", "extensions-prototype");
		let run = operation;
		for (const root of [...roots.keys()].sort()) {
			const inner = run;
			run = () => changeInstallation(cache, root, inner);
		}
		await run();
		await precompileInstalledExtensions(localFiles, cache);
		for (const [root, packages] of roots) {
			const files = new Map<string, string | undefined>();
			for (const pkg of packages) {
				if (!existsSync(pkg)) continue;
				for (const path of this.collectManifestFiles(pkg, "extensions").allFiles) {
					files.set(path, pathsEqual(canonicalizePath(pkg), pkg) && pathsEqual(canonicalizePath(path), path) ? root : undefined);
				}
			}
			await precompileInstalledExtensions(files, cache);
		}
	}
`;
	const insert = "\n\tsetProgressCallback(callback: ProgressCallback | undefined): void {";
	source = replaceOnce(source, insert, methods + insert);
	for (const action of ["install", "remove"]) {
		const start = `await this.withProgress("${action}", source,`;
		const index = source.indexOf(start, source.indexOf(`\n\tasync ${action}(source:`));
		const end = source.indexOf("\n\t\t});\n\t}", index);
		if (index < 0 || end < 0) throw new Error(`Unexpected package operation: ${action}`);
		const body = `${source.slice(index + "await ".length, end)}\n\t\t})`;
		const entries =
			action === "remove"
				? 'parsed.type === "local" ? [] : [{parsed, scope}]'
				: '[{parsed: parsed.type === "local" ? { ...parsed, path: this.resolvePath(parsed.path) } : parsed, scope}]';
		source = `${source.slice(0, index)}await this.withPrecompileChange(${entries}, () => ${body})${source.slice(end + "\n\t\t})".length)}`;
	}
	const update = "await this.updateConfiguredSources(updateSources);";
	source = replaceOnce(
		source,
		update,
		"await this.withPrecompileChange(updateSources.map(({ source, scope }) => ({ parsed: this.parseSource(source), scope })), () => this.updateConfiguredSources(updateSources));",
	);
	const automatic = "this.installParsedSource(parsed, resolvedScope),";
	return replaceOnce(
		source,
		automatic,
		"this.withPrecompileChange([{ parsed, scope: resolvedScope }], () => this.installParsedSource(parsed, resolvedScope)),",
	);
}
