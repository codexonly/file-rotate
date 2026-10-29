# file-wiki

自动轮替的 [file.kiwi](https://file.kiwi) 分享链接，用于一个较大的 ISO 镜像。

链接由 [`.github/workflows/rotate.yml`](.github/workflows/rotate.yml) 定期刷新：**从上一轮的
file.kiwi 链接取源**，重新加密上传，再把新链接写回本文件。不需要外部对象存储。
每次轮替完成后会同步一份到 Codeberg（GitHub 在中国大陆访问不稳定）。

<!-- filekiwi:start -->
**当前链接**：https://file.kiwi/8af34d3e#ZKIV_ruVCnNRsS5QYeGGWA

- 轮替时间：2026-10-29T14:13:46.645Z
- 有效期至：2026-10-30T14:13:46.645Z（免费下载窗口 24 小时）
- 文件：innosetup-6.7.3.iso（10.10 MB）
- SHA-256：9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732
<!-- filekiwi:end -->

## 为什么要轮替

- file.kiwi 的 WebFolder 约 **90 小时**后删除；
- 更要紧的是免费**下载窗口**：< 10 GB 的文件只有 **24 小时**（官方 [v2 文档](https://file.kiwi/api) 表格）。窗口一过，链接还在但下不动。

所以必须在 24 小时内把文件搬到新链接上，且新链接要能真正下载。

## 工作原理

1. 读 `README.md` 里标记之间的当前链接、上一轮链接、轮替时间和 SHA-256。
2. 链接还不到 12 小时就跳过（避免一个窗口里重复搬 6 GB）。
3. 用 [filekiwi-dlp](https://github.com/codexonly/filekiwi-dlp) 的预编译程序从**当前链接**下载源文件（引擎是 aria2，16 连接）；失败则退到**上一轮链接**，再失败才退到 `SOURCE_URL`（可选的外部兜底）。
4. 校验 SHA-256（优先用 `SOURCE_SHA256`，否则用 README 里记录的值）。
5. 新建 WebFolder，用 [`@file-kiwi/node`](https://github.com/file-kiwi/node) 做端到端加密（RFC 8188 / AES-128-GCM）分片上传。
6. 用 `filekiwi probe` 验证新链接确实能列出文件、能解开首块。
7. **只有以上全部成功**才改写 README 并提交 —— 失败的运行不会动现有链接。

## 时间线

```
T+0h   轮替完成，新链接生效（免费下载窗口 24h）
T+6h   检查：太新，跳过
T+12h  检查：到阈值，开始轮替（源链接已用掉一半窗口，还有 12h 余量）
T+18h  若 T+12h 那次失败，这里是第二次机会
T+24h  旧链接失效
```

固定每 6 小时检查一次，比"每天一次"多出一次重试机会；成功时约每 12 小时真正轮替一次。

## 失败与恢复

| 情况 | 结果 |
|---|---|
| 下载失败 | 自动重试 3 次，再依次换源 |
| 上传失败 / 新链接 probe 不通过 | 不写 README，旧链接继续可用，6 小时后重试 |
| 连续失败直到旧链接过期 | 链条断了，工作流开 issue 提醒 |
| 链条已断 | 手动触发工作流，在 `source_url` 里填一个新链接或外部 HTTP 地址 |

**链条断掉是不可自愈的**：file.kiwi 没有官方的下载接口，旧链接一旦过期就再也拿不回来。所以建议始终配置 `SOURCE_URL` 作为救援源。

## 需要配置的项

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `SOURCE_URL` | secret 或变量 | 否 | 外部兜底源（对象存储 / 上游原始地址）。链断时的救援路径 |
| `SOURCE_SHA256` | 变量 | 否 | ISO 的 SHA-256；设置后会强制校验，防止链上串了别的文件 |
| `TITLE` | 变量 | 否 | WebFolder 标题，默认 `轮替文件` |
| `MIN_AGE_HOURS` | 变量 | 否 | 触发轮替的最小链接年龄，默认 `12` |
| `ARIA2_SHA256` | 变量 | 否 | aria2 静态包（amd64）的 SHA-256。留空时只把实测值打印到日志，不做校验 |
| `CODEBERG_REPO` | 变量 | 否 | Codeberg 镜像仓库，格式 `用户名/file-wiki`。留空则不同步 |
| `CODEBERG_SSH_KEY` | 密钥(secret) | 否 | 该仓库的**部署密钥**私钥（必须勾选写权限） |
| `CODEBERG_KNOWN_HOSTS` | 变量 | 否 | `codeberg.org` 的主机公钥，钉死后不再依赖 ssh-keyscan |

`source_url` 也可以作为每次手动触发的临时输入，优先级高于以上配置。

## Codeberg 镜像

GitHub 在中国大陆访问不稳定，所以每次轮替完成后会额外推一份到 Codeberg：

- **GitHub 是唯一真源**，Codeberg 是只读镜像；推送用 `--force` 覆盖，在 Codeberg 上直接改 README 会在下次轮替时被冲掉；
- 只同步当前分支，但带完整历史（`actions/checkout` 用 `fetch-depth: 0`，否则浅克隆会被远端以 `shallow update not allowed` 拒绝）；
- 同步失败会让工作流变红并开 issue，但**不影响 GitHub 上的链接**——提交在那之前已经完成。

### 配置步骤

1. 在 Codeberg 建一个**空仓库**（不勾 README / license，否则首次推送会冲突）。
2. 生成一对专用密钥：

   ```bash
   ssh-keygen -t ed25519 -C "file-wiki mirror" -f codeberg -N ""
   ```

3. Codeberg 仓库 → Settings → Deploy keys → 添加 `codeberg.pub`，**勾选写权限**。
4. GitHub 仓库 → Settings → Secrets and variables → Actions：

   - Secret `CODEBERG_SSH_KEY`：`codeberg`（私钥）全文；
   - Variable `CODEBERG_REPO`：`你的用户名/file-wiki`；
   - Variable `CODEBERG_KNOWN_HOSTS`（推荐）：本机执行 `ssh-keyscan -t ed25519 codeberg.org` 的输出。
     不配置时会退回运行时 `ssh-keyscan`，属于首次连接即信任（TOFU）。

没配 `CODEBERG_REPO` 时这一步打印 notice 直接跳过，不影响原有流程。

## 关于下载器

[filekiwi-dlp](https://github.com/codexonly/filekiwi-dlp) 是第三方项目（非官方 demo，无 LICENSE），
走的是 file.kiwi **未文档化**的 Web 接口：

```
GET  /api/files/list?roomid=<folderId>
POST /api/getdlurl    → R2 预签名 URL，按 64 KiB ECE 记录分段 Range 请求
```

工作流固定版本 `2026.10.28`，并用 release 里的 `SHA2-256SUMS` 校验后再执行。需要留意：

- 这些接口随时可能变更或被加验证，届时链条会断（表现为下载 403/404）；
- 该项目的 README 写的"< 10 GB 免费窗口 48 小时"是过期数据，官方文档是 24 小时；
- 同一链接的下载次数有地区限制（韩国 3 次），不要拿它反复 probe + 全量下载做测试。

### aria2

下载走 `--engine aria2`（16 连接），二进制用的是
[Aria2-Pro-Core](https://github.com/P3TERX/Aria2-Pro-Core) 的静态构建
`1.36.0_2021.08.22`，工作流里现下现装、加入 `PATH`，下载器自动探测。该静态构建没有官方校验和，
所以配了 `ARIA2_SHA256` 变量才会强校验；没配时日志会打印实测值，第一次跑完把它填进变量即可。

## 本地调试

```bash
npm ci
PLAN_ONLY=1 SOURCE_URL="https://file.kiwi/xxxx#key" node scripts/rotate.mjs   # 只打印计划，不下载
```

正式跑需要 `FILEKIWI_BIN` 指向下载器可执行文件；`DOWNLOAD_ENGINE` 默认 `aria2`，
没有 aria2c 时改成 `internal` 即可。

## 目录结构

| 路径 | 作用 |
|---|---|
| `README.md` | 链接的唯一真实来源，由工作流改写 |
| `scripts/rotate.mjs` | 轮替主逻辑：取源 → 校验 → 上传 → 验证 → 回写 |
| `.github/workflows/rotate.yml` | 定时触发、安装依赖、提交结果、镜像 Codeberg、失败告警 |
| `package.json` / `package-lock.json` | 锁定 `@file-kiwi/node@1.0.9` |

## 已知限制

- 每天全量搬运两次（约 12 GB 下载 + 12 GB 上传），runner 需要约 8 GB 空闲磁盘；
- 单次 job 上限 350 分钟，上传分片是串行的（官方限制「concurrent chunk uploads = 1」）；
- 轮替期间旧链接仍然有效，新链接只有上传完成后才对外可见；
- aria2 的续传控制文件 `.aria2` 只在同一次运行内有用；跨运行续传等于重新下载；
- 没配 `CODEBERG_KNOWN_HOSTS` 时，主机密钥靠运行时 `ssh-keyscan` 获取（TOFU），要更严就把它钉死。
