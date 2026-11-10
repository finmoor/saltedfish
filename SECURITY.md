# 安全策略 / Security Policy

SaltedFish 让 AI Agent 操作你已登录的 Chrome。这里的漏洞可能让别人以你的身份操作网站，所以请私下报告，不要开公开 issue。

SaltedFish lets AI agents act in the Chrome profiles you are signed in to. A vulnerability here can let someone act on websites as you, so please report it privately instead of opening a public issue.

## 怎么报告 / How to report

在 GitHub 仓库的 **Security → Report a vulnerability** 提交私密报告（GitHub Private Vulnerability Reporting）。请写明：

- 受影响的版本（`saltedfish --version`，Chrome 扩展页上显示的版本）和操作系统；
- 复现步骤，最好能在一个干净的测试配置里复现；
- 你认为的影响：谁能做到什么，需要什么前提。

Use **Security → Report a vulnerability** on the GitHub repository. Include the affected version, OS, reproduction steps (ideally in a clean test profile), and the impact you see.

这是个人维护的项目，会尽快确认收到并评估，没有固定的响应时限。修复发布后会在发行说明里致谢（如果你愿意）。

This is a personally maintained project. Reports are acknowledged and assessed as soon as possible, without a fixed SLA. Reporters are credited in the release notes if they wish.

## 支持的版本 / Supported versions

只修最新发布的版本。Only the latest release receives security fixes.

## 范围 / Scope

属于漏洞的，例如：

- 未经授权就能调用 `/mcp`、`/rpc`、`/bridge` 或管理页接口，或绕过“`/mcp` 只接受本机连接”；
- 冒充或劫持浏览器配对、Agent 授权、管理页会话和一次性登录码；
- Agent 越过授权：操作没授权给它的 Chrome 配置，只读授权做了写操作，写到别的会话的标签组里；
- 读写 SaltedFish 数据目录（含令牌、配对密钥）或网络共享路径，让非管理员客户端打开 `file:` 地址；
- 扩展一键更新装上了不是来自已配对服务的代码；
- 网页内容让服务或扩展执行了调用方没要求的操作。

一般不算漏洞的（设计如此，见文档）：

- 已获授权、开了一次信任的 Agent，用你登录的身份做了它被允许的事；
- 你明确选择在内网用明文 HTTP/WS（`--allow-insecure-lan`）后，同一网络里的人能看到流量；
- 网站识别出了自动化操作；
- 需要先拿到本机管理员权限或本机用户的文件读写权限才能做到的事。

拿不准的也欢迎报告。If you are unsure whether something is in scope, report it anyway.
