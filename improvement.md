// 1. 获取dom后新增本地分析选项，与AI分析并列
// 2. 图标更换
// 3. 去除AI snapshot，只留 real dom + snapshot模式
// 4. 点击一键填充模式
5. 直接点选模式，上来就允许操作记录
// 6. 快捷键设定

```js
document.addEventListener('click', e => {
  console.log('isTrusted=',e.isTrusted);
  console.log('document.hasFocus()=',document.hasFocus())
}, true)
```