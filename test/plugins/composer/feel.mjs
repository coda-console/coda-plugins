// 流程测试共用：照引擎（bpmn-runs.mjs 的 typed）把脚本输出的 "true"/"false" 变成布尔值，再用与引擎同版本的 FEEL 求值。
import { evaluate } from 'feelin';

export const typedValue = value => (value === 'true' ? true : value === 'false' ? false : value);
export const typedOutputs = outputs => Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, typedValue(value)]));
export const typedContext = context => Object.fromEntries(Object.entries(context).map(([key, value]) => [key, typeof value === 'object' && value ? typedOutputs(value) : value]));
export const evaluateTyped = (expression, context) => evaluate(expression, typedContext(context)).value;
