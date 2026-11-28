// 研究记忆的常量：卡片的种类、状态、关系和各项上限。
export const KINDS = ['fact', 'conclusion', 'hypothesis', 'observation'];
export const STATUSES = ['active', 'contested', 'superseded', 'archived'];
export const RELATIONS = ['supersedes', 'contradicts', 'related'];
// 卡片放在 <memoryDir>/items/<id>.md。
export const ITEMS_DIR = 'items';
export const CARD_EXT = '.md';
// mnemon 的正文硬上限（字节）。
export const MAX_BODY_BYTES = 8000;
export const DEFAULT_IMPORTANCE = 3;
// 卡片 id 同时是文件名，只允许这些字符，路径穿越进不来。
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
