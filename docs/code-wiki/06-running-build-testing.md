# 运行构建与测试

## 环境要求

主要工具：

- Node.js / npm，仓库指定 `packageManager` 为 `npm@10.9.2`。
- Go，`go.mod` 指定 Go `1.25.6`。
- Taskfile，项目使用 `Taskfile.yml` 管理常用任务。
- Electron/Vite 相关依赖通过 npm 安装。

根包：

- `package.json`
- `package-lock.json`

Go 模块：

- `go.mod`
- `go.sum`

npm workspace：

- `tsunami/frontend`

## 安装依赖

常规安装：

```bash
npm install
```

Taskfile 中多数任务依赖 `npm:install`，因此也可以直接运行对应 task。

`postinstall.cjs` 会处理安装后的依赖准备逻辑；在特殊环境可通过环境变量跳过 app deps。

## 开发运行

### 推荐开发入口

```bash
task dev
```

等价 task：

```bash
task electron:dev
```

该任务会：

- 执行 `npm:install`。
- 构建 Go 后端 `wavesrv` 和 `wsh`。
- 构建 Tsunami scaffold。
- 运行 `npm run dev`。
- 设置 `WAVETERM_ENVFILE=.env`。
- 设置 `WAVETERM_NOCONFIRMQUIT=1`。

### 直接 Electron Vite dev

```bash
npm run dev
```

只运行：

```bash
electron-vite dev
```

如果后端二进制尚未构建，推荐先用 `task dev`。

### 快速开发

```bash
task electron:quickdev
```

特点：

- 只构建 macOS arm64 的 `wavesrv`。
- 不运行完整 generate。
- 不构建 `wsh`。
- 适合快速前端/main 进程联调。

Windows 快速开发：

```bash
task electron:winquickdev
```

### Preview server

```bash
task preview
```

用途：

- 启动独立组件预览服务。
- 不依赖 Electron。
- 不依赖 Go 后端。

目录：

```text
frontend/preview
```

端口：

```text
7007
```

## 启动预览模式

```bash
npm run start
```

或：

```bash
task start
task electron:start
```

底层命令：

```bash
electron-vite preview
```

## 构建

### 前端开发构建

```bash
npm run build:dev
```

或：

```bash
task build:frontend:dev
```

底层命令：

```bash
electron-vite build --mode development
```

### 前端生产构建

```bash
npm run build:prod
```

底层命令：

```bash
electron-vite build --mode production
```

### 后端构建

```bash
task build:backend
```

包含：

- `task build:server`
- `task build:wsh`

`build:server` 产物：

```text
dist/bin/wavesrv.*
```

`build:wsh` 产物：

```text
dist/bin/wsh*
```

### 完整打包

```bash
task package
```

流程：

1. `clean`
2. `npm:install`
3. `build:backend`
4. `build:tsunamiscaffold`
5. `npm run build:prod`
6. `electron-builder -c electron-builder.config.cjs -p never`

打包输出：

```text
make/
```

## Electron/Vite 配置

关键文件：

- `electron.vite.config.ts`

入口：

- main：`emain/emain.ts`
- preload：`emain/preload.ts`
- preload webview：`emain/preload-webview.ts`
- renderer：`index.html`

输出：

- main：`dist/main`
- preload：`dist/preload`
- renderer：`dist/frontend`

主要插件：

- `vite-tsconfig-paths`
- `vite-plugin-image-optimizer`
- `vite-plugin-svgr`
- React SWC
- Tailwind v4

manual chunks：

- `monaco`
- `mermaid`
- `katex`
- `shiki`
- `cytoscape`

特殊环境：

```bash
EDGEFLOW_LINK=1
```

当设置该变量且存在 sibling repo `../edgeFlow.js` 时，`edgeflowjs` 会 alias 到本地源码。

## Electron Builder 配置

关键文件：

- `electron-builder.config.cjs`

应用信息：

- appId：`dev.s-zx.crest`
- productName：`Crest`

产物目录：

```text
make/
```

打包内容：

- `dist`
- 根 `package.json`
- `dist/bin` 中当前 arch 的 `wavesrv` 和所有 `wsh`
- `dist/tsunamiscaffold` extra resources

目标平台：

- macOS：`zip`、`dmg`，支持 `arm64`、`x64`。
- Linux：`zip`、`deb`、`rpm`、`snap`、`AppImage`、`pacman`。
- Windows：`nsis`、`msi`、`zip`。

Windows 签名：

```bash
SM_CODE_SIGNING_CERT_SHA1_HASH=<sha1>
```

## Go 构建细节

### wavesrv

Task：

```bash
task build:server
```

底层构建：

```bash
go build -tags "osusergo,sqlite_omit_load_extension" \
  -ldflags "... -X main.BuildTime=<time> -X main.WaveVersion=<version>" \
  -o dist/bin/wavesrv.<arch> \
  cmd/server/main-server.go
```

特点：

- `CGO_ENABLED=1`
- 注入 `BuildTime`
- 注入 `WaveVersion`
- macOS 同时构建 arm64 和 amd64
- Linux/Windows 按当前架构构建

### wsh

Task：

```bash
task build:wsh
```

特点：

- `CGO_ENABLED=0`
- 多平台并行构建
- 目标包括 darwin/linux/windows，含 arm64、amd64，以及部分 Linux mips/mips64。

## 代码生成

### 生成入口

```bash
task generate
```

执行：

```bash
go run cmd/generatets/main-generatets.go
go run cmd/generatego/main-generatego.go
```

并依赖：

```bash
task build:schema
```

### Schema 构建

```bash
task build:schema
```

执行：

```bash
go run cmd/generateschema/main-generateschema.go
```

然后复制：

```text
schema -> dist/schema
```

### 生成文件

不要手动编辑：

- `frontend/types/gotypes.d.ts`
- `frontend/app/store/wshclientapi.ts`

常见触发条件：

- 修改 `pkg/wshrpc/wshrpctypes.go`。
- 修改需要暴露到 TS 的 Go 类型。
- 修改 config/schema 相关定义。

## 测试

### 前端/TypeScript 测试

```bash
npm test
```

底层：

```bash
vitest
```

覆盖率：

```bash
npm run coverage
```

底层：

```bash
vitest run --coverage
```

### TypeScript 类型检查

```bash
task check:ts
```

底层：

```bash
npx tsc --noEmit
```

覆盖：

- `frontend/**/*`
- `emain/**/*`

### 轻量 Vitest 配置

仓库有：

- `vitest.config.ts`
- `vitest.slim.config.ts`

`vitest.config.ts` 会合并 Electron renderer Vite 配置，适合依赖 alias/plugin 的测试。

`vitest.slim.config.ts` 用于纯逻辑测试，绕过共享 Electron/Vite 配置。

示例：

```bash
npx vitest run --config vitest.slim.config.ts <path>
```

### Go 测试

仓库包含多个 Go test 文件，例如：

- `pkg/cmdblock/parser_test.go`
- `pkg/filestore/blockstore_test.go`
- `pkg/gogen/gogen_test.go`
- `pkg/ijson/ijson_test.go`
- `pkg/tsgen/tsgenevent_test.go`
- `pkg/vdom/vdom_test.go`
- `cmd/wsh/cmd/*_test.go`

根据仓库规则，不要为了简单编译检查运行 `go build`；需要验证具体 Go 行为时运行有针对性的 `go test`。

## Tsunami 子项目

位置：

- `tsunami/`
- `tsunami/frontend/`

### 前端开发

```bash
task tsunami:frontend:dev
```

目录：

```text
tsunami/frontend
```

默认端口：

```text
12025
```

代理：

- `/api`
- `/assets`

目标：

```text
http://localhost:12026
```

### 前端构建

```bash
task tsunami:frontend:build
```

### Scaffold

```bash
task tsunami:scaffold
task build:tsunamiscaffold
```

产物最终复制到：

```text
dist/tsunamiscaffold
```

### Demo

```bash
task tsunami:demo:todo
```

Go demo 默认监听：

```text
localhost:12026
```

## 常用环境变量

| 变量 | 作用 |
| --- | --- |
| `WAVETERM_ENVFILE` | 指定 `.env` 文件路径。 |
| `WAVETERM_NOCONFIRMQUIT` | 开发时跳过退出确认。 |
| `WAVETERM_CONFIG_HOME` | 指定配置目录。 |
| `WAVETERM_DATA_HOME` | 指定数据目录。 |
| `WAVETERM_HOME` | 指定 Wave home。 |
| `WAVETERM_DEV` | 开发模式相关判断。 |
| `WAVETERM_DEV_VITE` | Vite 开发模式相关判断。 |
| `NODE_ENV_ELECTRON_VITE` | Electron Vite 环境。 |
| `EDGEFLOW_LINK` | 本地联调 sibling `../edgeFlow.js`。 |
| `WAVETERM_SKIP_APP_DEPS` | 跳过部分 postinstall app deps。 |
| `SM_CODE_SIGNING_CERT_SHA1_HASH` | Windows 打包签名证书 SHA1。 |

## 常用命令速查

| 场景 | 命令 |
| --- | --- |
| 安装依赖 | `npm install` |
| 开发运行 | `task dev` |
| 快速开发 | `task electron:quickdev` |
| Electron Vite dev | `npm run dev` |
| Preview server | `task preview` |
| 预览已构建 app | `task start` |
| 前端 dev build | `task build:frontend:dev` |
| 后端构建 | `task build:backend` |
| 完整打包 | `task package` |
| 代码生成 | `task generate` |
| Schema 构建 | `task build:schema` |
| 前端测试 | `npm test` |
| 覆盖率 | `npm run coverage` |
| TS 类型检查 | `task check:ts` |

## 常见问题

### README 中的 `BUILD.md` 不存在

当前 README 指向 `BUILD.md`，但仓库根目录未发现该文件。构建信息应以 `Taskfile.yml`、`package.json`、`electron.vite.config.ts`、`electron-builder.config.cjs` 为准。

### 修改 RPC 后前端类型不更新

确认执行：

```bash
task generate
```

并检查生成文件：

- `frontend/types/gotypes.d.ts`
- `frontend/app/store/wshclientapi.ts`

### Electron dev 启动但后端不可用

优先使用：

```bash
task dev
```

而不是直接：

```bash
npm run dev
```

因为 `task dev` 会先构建 `wavesrv` 和 `wsh`。
