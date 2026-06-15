Playwright 常用操作汇总：

## 元素交互
- `click()` — 点击元素
- `dblclick()` — 双击
- `fill()` — 填写输入框（清空后输入）
- `type()` — 逐字符输入（模拟真实键盘）
- `press()` — 按键，如 `press('Enter')`
- `tap()` — 触摸点击（移动端）
- `check()` / `uncheck()` — 勾选/取消复选框
- `selectOption()` — 下拉框选值
- `setInputFiles()` — 上传文件
- `focus()` / `blur()` — 聚焦/失焦
- `hover()` — 鼠标悬停
- `clear()` — 清空输入框

## 拖拽
- `dragTo()` — 拖拽到目标元素
- `dragAndDrop()` — page 级别拖拽

## 等待
- `waitForSelector()` — 等待元素出现
- `waitForTimeout()` — 等待指定毫秒
- `waitForURL()` — 等待 URL 变化
- `waitForNavigation()` — 等待页面跳转
- `waitForLoadState()` — 等待加载状态（load / networkidle）
- `waitForResponse()` / `waitForRequest()` — 等待网络请求

## 页面操作
- `goto()` — 跳转 URL
- `reload()` — 刷新
- `goBack()` / `goForward()` — 浏览器前进后退
- `screenshot()` — 截图
- `pdf()` — 生成 PDF
- `evaluate()` — 在页面内执行 JS
- `evaluateHandle()` — 执行 JS 并返回句柄

## 断言（expect）
- `toBeVisible()` / `toBeHidden()`
- `toHaveText()` / `toContainText()`
- `toHaveValue()` — 输入框值断言
- `toHaveURL()`
- `toBeChecked()`
- `toHaveCount()` — 元素数量断言
- `toHaveAttribute()`

## 网络拦截
- `route()` — 拦截/修改请求
- `unroute()` — 取消拦截

## 键鼠底层控制
- `mouse.move()` / `mouse.click()` / `mouse.down()` / `mouse.up()`
- `keyboard.type()` / `keyboard.press()` / `keyboard.down()`

## 多窗口 / Frame
- `page.frames()` — 获取所有 frame
- `frameLocator()` — 定位 iframe 内元素
- `context.newPage()` — 新建标签页
- `page.waitForEvent('popup')` — 等待弹出窗口

---

日常自动化测试用得最多的是 `click`、`fill`、`selectOption`、`expect` 断言这几类，有具体场景的话可以进一步展开。

```js
await page.getByRole('combobox', { name: 'Select/Enter Journal Name' }).click();
await page.getByRole('option').first().click();
await page.getByRole('combobox', { name: 'Selecting the journal name will automatically populate the journal code' }).click();
await page.getByRole('option').first().click();
await page.getByPlaceholder('Please enter the Special Issue title').fill('Advances in Sustainable Energy Solutions');
await page.getByPlaceholder('Please introduce the background and significance of your proposed special issue. We strongly recommend that you use at least 500 characters to describe the aims & scope.').fill('This special issue aims to explore cutting-edge research in sustainable energy technologies, focusing on renewable energy integration, advanced energy storage systems, and smart grid innovations. The background of this proposal stems from the urgent need to transition towards a low-carbon economy and mitigate climate change impacts. Significant advancements in solar photovoltaic efficiency, wind turbine design, and bioenergy conversion have opened new avenues for clean power generation. However, the intermittent nature of renewable sources poses challenges for grid stability, necessitating robust energy storage solutions such as lithium-ion batteries, flow batteries, and hydrogen storage. Furthermore, the digitalization of power systems through IoT-enabled sensors and AI-driven control algorithms promises to revolutionize energy management. This special issue will compile original research articles, reviews, and case studies that address the technical, economic, and policy dimensions of sustainable energy. Topics of interest include but are not limited to next-generation photovoltaic materials, offshore wind farm optimization, biomass gasification, thermal energy storage, vehicle-to-grid technology, microgrid resilience, and life-cycle assessment of energy systems. By bringing together interdisciplinary perspectives, this issue will provide a comprehensive overview of the current state and future directions of sustainable energy research, fostering collaboration and accelerating the deployment of clean technologies worldwide.');
await page.getByPlaceholder('Enter Topic 1').fill('Renewable Energy Systems');
await page.getByPlaceholder('Enter Topic 2').fill('Energy Storage Technologies');
await page.getByPlaceholder('Enter Topic 3').fill('Smart Grid and Microgrid Resilience');
await page.getByPlaceholder('Please input your reference list here.').fill(`1. Smith, J. et al. (2023) 'Advances in Solar Cell Efficiency', Renewable Energy Journal, 45(2), pp. 123-145.
2. Lee, K. and Patel, R. (2022) 'Flow Battery Technology for Grid Scale Storage', Energy Storage Materials, 18(4), pp. 210-230.
3. Zhang, Y. et al. (2021) 'IoT-enabled Smart Grids: A Review', IEEE Transactions on Smart Grid, 12(3), pp. 1405-1420.`);
await page.getByRole('combobox', { name: 'Select Content Commissioning Approaches' }).click();
await page.getByRole('option').first().click();


await page.keyboard.type('第一段文字\n第二段文字\n第三段文字');

  await page.locator('text=References').locator('..').getByRole('textbox').fill(`
asdf
  second
    third
  `);
  await page.locator('text=References ~ textbox').fill('nihao');
```