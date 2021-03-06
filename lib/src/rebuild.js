"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const spawn_rx_1 = require("spawn-rx");
const crypto = require("crypto");
const debug = require("debug");
const detectLibc = require("detect-libc");
const EventEmitter = require("events");
const fs = require("fs-extra");
const nodeAbi = require("node-abi");
const os = require("os");
const path = require("path");
const read_package_json_1 = require("./read-package-json");
const cache_1 = require("./cache");
const d = debug('electron-rebuild');
const defaultMode = process.platform === 'win32' ? 'sequential' : 'parallel';
const defaultTypes = ['prod', 'optional'];
// Update this number if you change the caching logic to ensure no bad cache hits
const ELECTRON_REBUILD_CACHE_ID = 1;
const locateBinary = (basePath, suffix) => __awaiter(this, void 0, void 0, function* () {
    let testPath = basePath;
    for (let upDir = 0; upDir <= 20; upDir++) {
        const checkPath = path.resolve(testPath, suffix);
        if (yield fs.exists(checkPath)) {
            return checkPath;
        }
        testPath = path.resolve(testPath, '..');
    }
    return null;
});
const locateNodeGyp = () => __awaiter(this, void 0, void 0, function* () {
    return yield locateBinary(__dirname, `node_modules/.bin/node-gyp${process.platform === 'win32' ? '.cmd' : ''}`);
});
const locatePrebuild = (modulePath) => __awaiter(this, void 0, void 0, function* () {
    return yield locateBinary(modulePath, 'node_modules/prebuild-install/bin.js');
});
class Rebuilder {
    constructor(options) {
        this.hashDirectory = (dir, relativeTo = dir) => __awaiter(this, void 0, void 0, function* () {
            d('hashing dir', dir);
            const dirTree = {};
            yield Promise.all((yield fs.readdir(dir)).map((child) => __awaiter(this, void 0, void 0, function* () {
                d('found child', child, 'in dir', dir);
                // Ignore output directories
                if (dir === relativeTo && (child === 'build' || child === 'bin'))
                    return;
                // Don't hash nested node_modules
                if (child === 'node_modules')
                    return;
                const childPath = path.resolve(dir, child);
                const relative = path.relative(relativeTo, childPath);
                if ((yield fs.stat(childPath)).isDirectory()) {
                    dirTree[relative] = yield this.hashDirectory(childPath, relativeTo);
                }
                else {
                    dirTree[relative] = crypto.createHash('SHA256').update(yield fs.readFile(childPath)).digest('hex');
                }
            })));
            return dirTree;
        });
        this.dHashTree = (tree, hash) => {
            for (const key of Object.keys(tree).sort()) {
                hash.update(key);
                if (typeof tree[key] === 'string') {
                    hash.update(tree[key]);
                }
                else {
                    this.dHashTree(tree[key], hash);
                }
            }
        };
        this.generateCacheKey = (opts) => __awaiter(this, void 0, void 0, function* () {
            const tree = yield this.hashDirectory(opts.modulePath);
            const hasher = crypto.createHash('SHA256')
                .update(`${ELECTRON_REBUILD_CACHE_ID}`)
                .update(path.basename(opts.modulePath))
                .update(this.ABI)
                .update(this.arch)
                .update(this.debug ? 'debug' : 'not debug')
                .update(this.headerURL)
                .update(this.electronVersion);
            this.dHashTree(tree, hasher);
            const hash = hasher.digest('hex');
            d('calculated hash of', opts.modulePath, 'to be', hash);
            return hash;
        });
        this.lifecycle = options.lifecycle;
        this.buildPath = options.buildPath;
        this.electronVersion = options.electronVersion;
        this.arch = options.arch || process.arch;
        this.extraModules = options.extraModules || [];
        this.onlyModules = options.onlyModules || null;
        this.force = options.force || false;
        this.headerURL = options.headerURL || 'https://atom.io/download/electron';
        this.types = options.types || defaultTypes;
        this.mode = options.mode || defaultMode;
        this.debug = options.debug || false;
        this.useCache = options.useCache || false;
        this.cachePath = options.cachePath || path.resolve(os.homedir(), '.electron-rebuild-cache');
        if (this.useCache && this.force) {
            console.warn('[WARNING]: Electron Rebuild has force enabled and cache enabled, force take precedence and the cache will not be used.');
            this.useCache = false;
        }
        if (typeof this.electronVersion === 'number') {
            if (`${this.electronVersion}`.split('.').length === 1) {
                this.electronVersion = `${this.electronVersion}.0.0`;
            }
            else {
                this.electronVersion = `${this.electronVersion}.0`;
            }
        }
        if (typeof this.electronVersion !== 'string') {
            throw new Error(`Expected a string version for electron version, got a "${typeof this.electronVersion}"`);
        }
        this.ABI = nodeAbi.getAbi(this.electronVersion, 'electron');
        this.prodDeps = this.extraModules.reduce((acc, x) => acc.add(x), new Set());
        this.rebuilds = [];
        this.realModulePaths = new Set();
        this.realNodeModulesPaths = new Set();
    }
    rebuild() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!path.isAbsolute(this.buildPath)) {
                throw new Error('Expected buildPath to be an absolute path');
            }
            d('rebuilding with args:', this.buildPath, this.electronVersion, this.arch, this.extraModules, this.force, this.headerURL, this.types, this.debug);
            this.lifecycle.emit('start');
            const rootPackageJson = yield read_package_json_1.readPackageJson(this.buildPath);
            const markWaiters = [];
            const depKeys = [];
            if (this.types.indexOf('prod') !== -1 || this.onlyModules) {
                depKeys.push(...Object.keys(rootPackageJson.dependencies || {}));
            }
            if (this.types.indexOf('optional') !== -1 || this.onlyModules) {
                depKeys.push(...Object.keys(rootPackageJson.optionalDependencies || {}));
            }
            if (this.types.indexOf('dev') !== -1 || this.onlyModules) {
                depKeys.push(...Object.keys(rootPackageJson.devDependencies || {}));
            }
            depKeys.forEach((key) => {
                this.prodDeps[key] = true;
                markWaiters.push(this.markChildrenAsProdDeps(path.resolve(this.buildPath, 'node_modules', key)));
            });
            yield Promise.all(markWaiters);
            d('identified prod deps:', this.prodDeps);
            yield this.rebuildAllModulesIn(path.resolve(this.buildPath, 'node_modules'));
            this.rebuilds.push(() => this.rebuildModuleAt(this.buildPath));
            if (this.mode !== 'sequential') {
                yield Promise.all(this.rebuilds.map(fn => fn()));
            }
            else {
                for (const rebuildFn of this.rebuilds) {
                    yield rebuildFn();
                }
            }
        });
    }
    rebuildModuleAt(modulePath) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!(yield fs.exists(path.resolve(modulePath, 'binding.gyp')))) {
                return;
            }
            const nodeGypPath = yield locateNodeGyp();
            if (!nodeGypPath) {
                throw new Error('Could not locate node-gyp');
            }
            const buildType = this.debug ? 'Debug' : 'Release';
            const metaPath = path.resolve(modulePath, 'build', buildType, '.forge-meta');
            const metaData = `${this.arch}--${this.ABI}`;
            this.lifecycle.emit('module-found', path.basename(modulePath));
            if (!this.force && (yield fs.exists(metaPath))) {
                const meta = yield fs.readFile(metaPath, 'utf8');
                if (meta === metaData) {
                    d(`skipping: ${path.basename(modulePath)} as it is already built`);
                    this.lifecycle.emit('module-done');
                    this.lifecycle.emit('module-skip');
                    return;
                }
            }
            // prebuild already exists
            if (yield fs.exists(path.resolve(modulePath, 'prebuilds', `${process.platform}-${this.arch}`, `electron-${this.ABI}.node`))) {
                d(`skipping: ${path.basename(modulePath)} as it was prebuilt`);
                return;
            }
            let cacheKey;
            if (this.useCache) {
                cacheKey = yield this.generateCacheKey({
                    modulePath,
                });
                const applyDiffFn = yield cache_1.lookupModuleState(this.cachePath, cacheKey);
                if (applyDiffFn) {
                    yield applyDiffFn(modulePath);
                    this.lifecycle.emit('module-done');
                    return;
                }
            }
            const modulePackageJson = yield read_package_json_1.readPackageJson(modulePath);
            if ((modulePackageJson.dependencies || {})['prebuild-install']) {
                d(`assuming is prebuild powered: ${path.basename(modulePath)}`);
                const prebuildInstallPath = yield locatePrebuild(modulePath);
                if (prebuildInstallPath) {
                    d(`triggering prebuild download step: ${path.basename(modulePath)}`);
                    let success = false;
                    try {
                        yield spawn_rx_1.spawnPromise(process.execPath, [
                            path.resolve(__dirname, 'prebuild-shim.js'),
                            prebuildInstallPath,
                            `--arch=${this.arch}`,
                            `--platform=${process.platform}`,
                            '--runtime=electron',
                            `--target=${this.electronVersion}`
                        ], {
                            cwd: modulePath,
                        });
                        success = true;
                    }
                    catch (err) {
                        d('failed to use prebuild-install:', err);
                    }
                    if (success) {
                        d('built:', path.basename(modulePath));
                        yield fs.mkdirs(path.dirname(metaPath));
                        yield fs.writeFile(metaPath, metaData);
                        if (this.useCache) {
                            yield cache_1.cacheModuleState(modulePath, this.cachePath, cacheKey);
                        }
                        this.lifecycle.emit('module-done');
                        return;
                    }
                }
                else {
                    d(`could not find prebuild-install relative to: ${modulePath}`);
                }
            }
            if (modulePath.indexOf(' ') !== -1) {
                console.error('Attempting to build a module with a space in the path');
                console.error('See https://github.com/nodejs/node-gyp/issues/65#issuecomment-368820565 for reasons why this may not work');
                // FIXME: Re-enable the throw when more research has been done
                // throw new Error(`node-gyp does not support building modules with spaces in their path, tried to build: ${modulePath}`);
            }
            d('rebuilding:', path.basename(modulePath));
            const rebuildArgs = [
                'rebuild',
                `--target=${this.electronVersion}`,
                `--arch=${this.arch}`,
                `--dist-url=${this.headerURL}`,
                '--build-from-source',
            ];
            if (this.debug) {
                rebuildArgs.push('--debug');
            }
            Object.keys(modulePackageJson.binary || {}).forEach((binaryKey) => {
                let value = modulePackageJson.binary[binaryKey];
                if (binaryKey === 'module_path') {
                    value = path.resolve(modulePath, value);
                }
                value = value.replace('{configuration}', buildType)
                    .replace('{node_abi}', `electron-v${this.electronVersion.split('.').slice(0, 2).join('.')}`)
                    .replace('{platform}', process.platform)
                    .replace('{arch}', this.arch)
                    .replace('{version}', modulePackageJson.version)
                    .replace('{libc}', detectLibc.family || 'unknown');
                Object.keys(modulePackageJson.binary).forEach((binaryReplaceKey) => {
                    value = value.replace(`{${binaryReplaceKey}}`, modulePackageJson.binary[binaryReplaceKey]);
                });
                rebuildArgs.push(`--${binaryKey}=${value}`);
            });
            if (process.env.GYP_MSVS_VERSION) {
                rebuildArgs.push(`--msvs_version=${process.env.GYP_MSVS_VERSION}`);
            }
            d('rebuilding', path.basename(modulePath), 'with args', rebuildArgs);
            yield spawn_rx_1.spawnPromise(nodeGypPath, rebuildArgs, {
                cwd: modulePath,
                env: Object.assign({}, process.env, {
                    HOME: path.resolve(os.homedir(), '.electron-gyp'),
                    USERPROFILE: path.resolve(os.homedir(), '.electron-gyp'),
                    npm_config_disturl: 'https://atom.io/download/electron',
                    npm_config_runtime: 'electron',
                    npm_config_arch: this.arch,
                    npm_config_target_arch: this.arch,
                    npm_config_build_from_source: 'true',
                    npm_config_debug: this.debug ? 'true' : '',
                }),
            });
            d('built:', path.basename(modulePath));
            yield fs.mkdirs(path.dirname(metaPath));
            yield fs.writeFile(metaPath, metaData);
            const moduleName = path.basename(modulePath);
            const buildLocation = 'build/' + buildType;
            d('searching for .node file', path.resolve(modulePath, buildLocation));
            d('testing files', (yield fs.readdir(path.resolve(modulePath, buildLocation))));
            const nodeFile = (yield fs.readdir(path.resolve(modulePath, buildLocation)))
                .find((file) => file !== '.node' && file.endsWith('.node'));
            const nodePath = nodeFile ? path.resolve(modulePath, buildLocation, nodeFile) : undefined;
            const abiPath = path.resolve(modulePath, `bin/${process.platform}-${this.arch}-${this.ABI}`);
            if (nodePath && (yield fs.exists(nodePath))) {
                d('found .node file', nodePath);
                d('copying to prebuilt place:', abiPath);
                yield fs.mkdirs(abiPath);
                yield fs.copy(nodePath, path.resolve(abiPath, `${moduleName}.node`));
            }
            if (this.useCache) {
                yield cache_1.cacheModuleState(modulePath, this.cachePath, cacheKey);
            }
            this.lifecycle.emit('module-done');
        });
    }
    rebuildAllModulesIn(nodeModulesPath, prefix = '') {
        return __awaiter(this, void 0, void 0, function* () {
            // Some package managers use symbolic links when installing node modules
            // we need to be sure we've never tested the a package before by resolving
            // all symlinks in the path and testing against a set
            const realNodeModulesPath = yield fs.realpath(nodeModulesPath);
            if (this.realNodeModulesPaths.has(realNodeModulesPath)) {
                return;
            }
            this.realNodeModulesPaths.add(realNodeModulesPath);
            d('scanning:', realNodeModulesPath);
            for (const modulePath of yield fs.readdir(realNodeModulesPath)) {
                // Ignore the magical .bin directory
                if (modulePath === '.bin')
                    continue;
                // Ensure that we don't mark modules as needing to be rebuilt more than once
                // by ignoring / resolving symlinks
                const realPath = yield fs.realpath(path.resolve(nodeModulesPath, modulePath));
                if (this.realModulePaths.has(realPath)) {
                    continue;
                }
                this.realModulePaths.add(realPath);
                if (this.prodDeps[`${prefix}${modulePath}`] && (!this.onlyModules || this.onlyModules.includes(modulePath))) {
                    this.rebuilds.push(() => this.rebuildModuleAt(realPath));
                }
                if (modulePath.startsWith('@')) {
                    yield this.rebuildAllModulesIn(realPath, `${modulePath}/`);
                }
                if (yield fs.exists(path.resolve(nodeModulesPath, modulePath, 'node_modules'))) {
                    yield this.rebuildAllModulesIn(path.resolve(realPath, 'node_modules'));
                }
            }
        });
    }
    ;
    findModule(moduleName, fromDir, foundFn) {
        return __awaiter(this, void 0, void 0, function* () {
            let targetDir = fromDir;
            const foundFns = [];
            while (targetDir !== path.dirname(this.buildPath)) {
                const testPath = path.resolve(targetDir, 'node_modules', moduleName);
                if (yield fs.exists(testPath)) {
                    foundFns.push(foundFn(testPath));
                }
                targetDir = path.dirname(targetDir);
            }
            yield Promise.all(foundFns);
        });
    }
    ;
    markChildrenAsProdDeps(modulePath) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!(yield fs.exists(modulePath))) {
                return;
            }
            d('exploring', modulePath);
            let childPackageJson;
            try {
                childPackageJson = yield read_package_json_1.readPackageJson(modulePath, true);
            }
            catch (err) {
                return;
            }
            const moduleWait = [];
            const callback = this.markChildrenAsProdDeps.bind(this);
            Object.keys(childPackageJson.dependencies || {}).concat(Object.keys(childPackageJson.optionalDependencies || {})).forEach((key) => {
                if (this.prodDeps[key]) {
                    return;
                }
                this.prodDeps[key] = true;
                moduleWait.push(this.findModule(key, modulePath, callback));
            });
            yield Promise.all(moduleWait);
        });
    }
    ;
}
function rebuildWithOptions(options) {
    d('rebuilding with args:', arguments);
    const lifecycle = new EventEmitter();
    const rebuilderOptions = Object.assign({}, options, { lifecycle });
    const rebuilder = new Rebuilder(rebuilderOptions);
    let ret = rebuilder.rebuild();
    ret.lifecycle = lifecycle;
    return ret;
}
function doRebuild(options, ...args) {
    if (typeof options === 'object') {
        return rebuildWithOptions(options);
    }
    console.warn('You are using the deprecated electron-rebuild API, please switch to using the options object instead');
    return rebuildWithOptions(createOptions(options, ...args));
}
exports.rebuild = doRebuild;
;
function createOptions(buildPath, electronVersion, arch, extraModules, force, headerURL, types, mode, onlyModules, debug) {
    return {
        buildPath,
        electronVersion,
        arch,
        extraModules,
        onlyModules,
        force,
        headerURL,
        types,
        mode,
        debug
    };
}
exports.createOptions = createOptions;
function rebuildNativeModules(electronVersion, modulePath, whichModule = '', _headersDir = null, arch = process.arch, _command, _ignoreDevDeps = false, _ignoreOptDeps = false, _verbose = false) {
    if (path.basename(modulePath) === 'node_modules') {
        modulePath = path.dirname(modulePath);
    }
    d('rebuilding in:', modulePath);
    console.warn('You are using the old API, please read the new docs and update to the new API');
    return exports.rebuild(modulePath, electronVersion, arch, whichModule.split(','));
}
exports.rebuildNativeModules = rebuildNativeModules;
;
//# sourceMappingURL=rebuild.js.map