// 开工检查：「验收时占用」只填环境组，不能填设备的组。
// 设备的组名由测试机插件生成（plugins/testbed/scripts/resolve-device.mjs）：iOS 是 device:<设备名>，安卓是 entity:<UUID>；
// 设备的组只能经「验收设备」占，否则两个需求交叉着填（甲 hold=设备 A、设备 B，乙 hold=设备 B、设备 A）仍会各占一台再等对方。
// 宿主取锁前会去掉组名首尾的空白，这里也先去掉。
const hold = (process.env.HOLD ?? '').trim();
if (/^(device|entity):/.test(hold)) {
  console.error(`「验收时占用」不能填设备的组（${hold}）：设备的组只能经「验收设备」占，设备名填在「验收设备」里，「验收时占用」只填环境组。`);
  process.exit(1);
}
