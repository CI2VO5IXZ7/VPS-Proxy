# VPS-Proxy

部署在境外 VPS 上的加速代理，用两个独立域名提供两项服务：

- **Telegram Bot API 代理**（`TG_DOMAIN`）：与 [telegram-bot-proxy](https://github.com/CI2VO5IXZ7/telegram-bot-proxy)（Cloudflare Worker 版）用法完全相同，可互为备份；
- **GitHub 加速**（`GH_DOMAIN`）：加速 Release / 源码包 / raw 文件下载与 `git clone`。

由 Caddy（自动申请和续期 HTTPS 证书，同时监听 IPv4/IPv6）和一个无第三方依赖的 Node.js 脚本 `server.js` 组成，使用 Docker Compose 部署。

## 部署

前提：

- VPS 能直连 `api.telegram.org` 和 `github.com`；
- 两个域名的 A（IPv4）和 AAAA（IPv6）记录都指向这台 VPS；若域名托管在 Cloudflare，请关闭代理（灰色云朵），否则流量会经过 Cloudflare；
- 防火墙 / 安全组放行 80 和 443 端口（IPv4 和 IPv6，443 建议同时放行 UDP 以支持 HTTP/3），且这两个端口没有被 Nginx 等其他程序占用；
- 已安装 Docker 和 Docker Compose 插件。

```bash
git clone https://github.com/CI2VO5IXZ7/VPS-Proxy.git
cd VPS-Proxy
cp .env.example .env
vi .env            # 填写两个域名和 ALLOWED_BOT_TOKENS
docker compose up -d
docker compose logs -f caddy   # 看到两个域名的 "certificate obtained successfully" 即证书申请成功
```

`.env` 配置项：

| 变量 | 说明 |
| --- | --- |
| `TG_DOMAIN` | Telegram 代理域名 |
| `GH_DOMAIN` | GitHub 加速域名 |
| `ALLOWED_BOT_TOKENS` | 允许使用的 Bot Token，多个用英文逗号分隔；为空时 Telegram 请求一律返回 503，不在白名单内返回 403 |
| `GH_ALLOWED_OWNERS` | 可选，只加速这些 GitHub 用户 / 组织的仓库，逗号分隔；为空则不限制 |

修改 `.env` 或更新代码后执行：

```bash
git pull
docker compose up -d --force-recreate
```

## Telegram Bot API 代理

把脚本里的 `api.telegram.org` 换成 `TG_DOMAIN` 即可，路径和请求格式不变：

```bash
curl -X POST "https://{TG_DOMAIN}/bot{TOKEN}/sendMessage" \
     -H "Content-Type: application/json" \
     -d '{"chat_id": "123456789", "text": "Hello"}'
```

- `/bot{TOKEN}/{method}`：GET / POST（含 `multipart/form-data` 上传文件）；
- `/file/bot{TOKEN}/{file_path}`：GET，下载文件（先用 `getFile` 获取 `file_path`）。

Hermes Agent 在 `~/.hermes/config.yaml` 中配置：

```yaml
platforms:
  telegram:
    extra:
      base_url: "https://{TG_DOMAIN}/bot"
      base_file_url: "https://{TG_DOMAIN}/file/bot"
```

## GitHub 加速

在原始链接前加上 `https://{GH_DOMAIN}/`（`https://` 前缀可省略）：

```bash
# Release 附件 / 源码包
curl -O https://{GH_DOMAIN}/https://github.com/{owner}/{repo}/releases/download/{tag}/{file}
curl -O https://{GH_DOMAIN}/https://github.com/{owner}/{repo}/archive/refs/heads/main.zip

# 单个文件（blob 链接会自动转成 raw）
curl -O https://{GH_DOMAIN}/https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
curl -O https://{GH_DOMAIN}/https://github.com/{owner}/{repo}/blob/{ref}/{path}

# git clone（只读）
git clone https://{GH_DOMAIN}/https://github.com/{owner}/{repo}.git
```

- 支持 `github.com` 的 `releases` / `archive` / `blob` / `raw` 及 `git clone`，以及 `raw.githubusercontent.com`、`gist.githubusercontent.com`、`gist.github.com/{user}/{id}/raw/...`、`codeload.github.com`；
- GitHub 的跳转（如 Release 附件跳到 `release-assets.githubusercontent.com`）在服务端完成，`curl` 无需 `-L`；
- 不代理 GitHub 网页、登录页和 API，也不支持 `git push`；
- 克隆私有仓库时，凭据会经过这台 VPS 转发给 GitHub。

## 自检

```bash
curl https://{TG_DOMAIN}/bot{TOKEN}/getMe
curl -6 https://{TG_DOMAIN}/bot{TOKEN}/getMe      # 检查 IPv6
curl -I https://{GH_DOMAIN}/https://github.com/cli/cli/releases/download/v2.60.0/gh_2.60.0_checksums.txt
```
