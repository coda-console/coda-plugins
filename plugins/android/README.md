# 安卓手机

0.4.0（接口破坏性变更）：本体与链路合成一条 `coda/group@1` 记录，不再写 `coda/entity@1`、`coda/link@1`；借出、归还改为记录上的 `lend`、`return` 操作（`coda.handle('coda/group@1', …)`），不再用 `coda.resources.handle`；设置读 `coda.settings.get`。`android.name` 现在是不含空白的设备名，组名为 `device:<设备名>`，默认取 `ro.product.device`（原先取型号 `ro.product.model`，有空格，当不了组名），型号改放 `attributes.model`。需要先带这套记录的 Coda。只给预览渠道。

升级注意：原先的本体、链路记录由 Coda 的迁移删去，借着的手机不接续；组名由 `entity:<UUID>` 改为 `device:<设备名>`，请在 xiaomi 上把 `android.name` 设成 `xiaomi`（与 testbed 的写法一致），testbed 的 `testbed.entities` 不再用。

版本 0.4.0。只装在 xiaomi（Mi 10 Pro）的 Debian chroot 后端，插件宿主须为 root，能用 `nsenter -t 1 -m -- sh` 执行 Android 命令。不依赖 host 插件，也不把手机登记为构建执行环境；无运行时依赖。

启动时写一条 `coda/group@1`（key 为 `device`），保管方就是 xiaomi。记录 ID 由宿主按后端、插件、种类和 key 派生，每次启动相同，插件不生成也不保存；插件只写 `spec`，`status`（`free`、`lending`、`held`、`returning`、`failed` 与持有方）归 Coda。勿在两个实例同时声明。记录的 `spec`：

| 字段 | 内容 |
| --- | --- |
| `name` | `device:<android.name>` |
| `capacity` | `1` |
| `lends` | `true`：排到后由 Coda 先调 `lend`，放开后调 `return` |
| `attributes` | `platform: android`、`model`（`ro.product.model`）、`android`（系统版本）、`serial`（序列号） |
| `unique` | `['serial']` |
| `reach` | `android.machines` 非空时为 `{ scope: 'machines', machines }`，空时不写（全空间可排队） |
| `links` | `android.machines` 非空时一条 `{ protocol: 'adb', endpoint: '<地址>:<端口>', reach }`（`reach` 同上），空时不写 |

## 设置

修改设置后重启插件生效。

| 设置 | 默认值与作用 |
| --- | --- |
| `android.name` | 空，使用 `ro.product.device`；填写时仅填不含空白的设备名 |
| `android.address` | 空，使用 wlan0 的 IPv4；填写时仅填地址 |
| `android.machines` | 空数组，不写 `reach`、`links`；每行填写一个可排队借用、可使用 adb 链路的机器 ID（`id` 列） |

网络 adb 链路的端口读取 `persist.adb.tcp.port`，不修改 adb 或网络设置。插件只声明可达范围，不探测连通性；adb 公钥授权仍须手工完成。

## 借出与归还

使用方申请 `device:<设备名>`，由核心向保管方排队；排到后 Coda 调本插件的 `lend`，放开后调 `return`，两个操作只许 Coda 调：

- `lend`：读取 system、secure、global 三张 settings 表，快照写入插件状态目录的 `settings.json`；答 `{}`。
- `return`：停止 frida-server，回到桌面，熄屏并等 3 秒，再与快照比较；只恢复变化的项，并只核对写过的项。成功后删除快照，答 `{}`。
- 没有快照时只回到桌面、熄屏，不写设置。

任何步骤失败都会抛错，保留快照，由核心把记录置为 `failed` 并停住队列。插件下次重新给出这条记录时，核心重试未完成的归还。解析、比较、核对与 shell 引号逻辑复制自 testbed 的 Android 脚本，插件之间不互相 import。

## 使用约定

只读的使用不占用本体；没借到就不动手机的交互状态。默认输入法应为 `org.quietboard/.Board`，借出前处于该值时，归还的设置复原会保住它。插件不会另行设置默认输入法。
