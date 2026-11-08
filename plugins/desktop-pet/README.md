# 桌面宠物

Coda 娘待在 Mac 的桌面上：站在 Dock 上走来走去，Agent 在跑时抱着笔记本打字，有会话需要你操作时举起卡片、头上冒出「有 N 件事等你」，点气泡直接打开那个会话。
拖起来能把她扔到别处，落地会压扁一下；点一下她会开心；双击缩成贴在屏幕边上的悬浮球（三色环，在跑时转、有事等你时角上是数字），点球去处理等你的事或变回来；右键是菜单。

在 Coda 的插件页「桌面宠物」（Mac 左侧栏「资源」下）点「放到桌面上」。她是 Coda 的[浮窗](https://github.com/coda-console/coda/blob/main/docs/plugins.md)：透明、置顶、在每个桌面空间里，只有她身上接鼠标，别处的点击落到下面的窗口；下次启动 Coda 还在。iPhone 上还不能放。

| 文件 | 内容 |
| --- | --- |
| `main.mjs` | 模块：看这台机器的会话（`threads`：哪些有一轮在跑、哪些需要你操作），告诉每个开着的宠物；插件页的「收起」经它让宠物关掉 |
| `view/rules.js` | 她的规则：按帧（60 帧/秒）推进，只看帧号、你做了什么和 Coda 的状态；没有时钟、不碰页面，测试在 `test/plugins/desktop-pet/` |
| `view/pet.html`、`view/pet.js` | 浮窗里的页面：画她、按她的位置挪窗口（`coda.place`）、声明哪里接鼠标（`coda.layout({ surfaces })`）、接手势；用 Coda 标准库的 `loop.js`、`gestures.js`、`bridge.js` |
| `view/home.html`、`view/home.js` | 插件页：放到桌面上（`coda.open({ view: 'pet', presentation: 'float' })`）或收起 |
| `view/sprites/` | 各个动作的帧，256×256 透明 PNG、朝右（朝左由页面镜像）；缺的帧用 `placeholder.png`（同 `idle-1`）。图由 Codex（gpt-6-astra）生成 |
