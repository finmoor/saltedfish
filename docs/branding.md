# 名称与兼容标识

## 产品名称

正式写法为 **SaltedFish**，大写 S、F，连写。

- 英文标语：You chill. Agents browse.
- 中文标语：Agent 干活，你当咸鱼
- npm 包名及命令：`saltedfish`
- MCP 连接名：`saltedfish`
- 当前服务、npm 包和 Chrome 扩展使用同一版本号：`0.3.28`。

## 保留的兼容标识

工具名前缀 `chrome_*`、环境变量前缀 `CHROME_MCP_*` 为兼容保留。品牌名不改变工具协议、浏览器身份或已有配对。

旧连接名 `feng-chrome` 会在 `connect` 或 `upgrade` 刷新已登记配置时自动迁移为 `saltedfish`，沿用审批设置。配置中两个名称同时存在时，以 `saltedfish` 为准。自动刷新只处理可确认归属的连接；其他配置需显式运行 `connect`。

迁移前备份配置，已打开的客户端会话需重连。`connect --restore ID` 可在文件没有后续改动时恢复原配置。安装和升级见[npm 指南](npm.md)，审批边界见[一次信任](once-trust.md)。
