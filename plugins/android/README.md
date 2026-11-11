# 安卓手机

版本 0.1.0。只装在 xiaomi（Mi 10 Pro）的 Debian chroot 后端，插件宿主须为 root，能用 `nsenter -t 1 -m -- sh` 执行 Android 命令。不依赖 host 插件，也不把手机登记为构建执行环境；无运行时依赖。

首次启动在插件状态目录生成并保存 `entity-id`，之后沿用这个 UUID。启动时以 `android` 类别、容量 1 声明本体，保管方就是 xiaomi；属性包含型号、Android 版本、序列号。迁移保管方时须保留 `entity-id`，勿在两个实例同时声明。

## 设置

修改设置后重启插件生效。

| 设置 | 默认值与作用 |
| --- | --- |
| `android.name` | 空，使用 `ro.product.model` 作为本体名称 |
| `android.address` | 空，使用 wlan0 的 IPv4；填写时仅填地址 |
| `android.machines` | 空数组，不声明链路；每行填写一个可使用 adb 链路的机器 ID（`id` 列） |

网络 adb 链路的端口读取 `persist.adb.tcp.port`，不修改 adb 或网络设置。插件只声明可达范围，不探测连通性；adb 公钥授权仍须手工完成。

## 借出与归还

使用方申请 `entity:<UUID>`，由核心向保管方排队。不管持有方是流程还是插件，都经过同一套钩子：

- 借出：读取 system、secure、global 三张 settings 表，快照写入插件状态目录的 `settings.json`。
- 归还：停止 frida-server，回到桌面，熄屏并等 3 秒，再与快照比较；只恢复变化的项，并只核对写过的项。成功后删除快照。
- 没有快照时只回到桌面、熄屏，不写设置。

任何步骤失败都会抛错，保留快照，由核心停住队列。插件下次重新声明本体时，核心重试未完成的归还。解析、比较、核对与 shell 引号逻辑复制自 testbed 的 Android 脚本，插件之间不互相 import。

## 使用约定

只读的使用不占用本体；没借到就不动手机的交互状态。默认输入法应为 `org.quietboard/.Board`，借出前处于该值时，归还的设置复原会保住它。插件不会另行设置默认输入法。
