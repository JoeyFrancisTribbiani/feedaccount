const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  let p = pages.find(pg => pg.url().includes('127.0.0.1:39210'));
  if (!p) { console.log('not found'); process.exit(1); }
  await p.bringToFront();
  await p.waitForTimeout(500);

  // 关闭所有弹窗
  await p.evaluate(() => {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
  });
  await p.waitForTimeout(500);

  // 点击 AI混剪 按钮打开弹窗
  const aiBtn = p.locator('button', { hasText: 'AI混剪' }).first();
  await aiBtn.click();
  console.log('clicked AI混剪');
  await p.waitForTimeout(1500);

  // 点击管理方案
  const manageBtn = p.locator('#modal-preset-manage');
  await manageBtn.click();
  console.log('clicked manage');
  await p.waitForTimeout(1500);

  // 点击新增方案
  const addBtn = p.locator('#preset-list-modal button', { hasText: '新增方案' });
  await addBtn.click();
  console.log('clicked add');
  await p.waitForTimeout(2000);
  await p.screenshot({ path: '../../test_new_preset.png' });
  console.log('new preset form screenshot saved');

  // 填写方案名称
  await p.locator('#preset-name').fill('测试穿搭指南方案');
  console.log('filled name');

  // 填写提示词
  await p.locator('#preset-prompt').fill('请直接处理我上传的【1个原始包包视频】，完整分析其中的真实包包、真实达人和真实场景，并在本次任务中一次性生成【10张彼此独立的9:16高清图片】。本任务只做图片生成，不做视频、音频、MP4、GIF、ZIP。');
  console.log('filled prompt');

  // 勾选穿搭指南
  const outfitCb = p.locator('#preset-outfit-guide');
  if (await outfitCb.count() > 0) {
    await outfitCb.check();
    console.log('checked outfit guide');
  } else {
    console.log('outfit guide checkbox not found');
  }

  // 确保资源类型选了图片
  const imgCb = p.locator('.preset-resource-type[value="image"]');
  if (await imgCb.count() > 0) {
    await imgCb.check();
    console.log('checked image type');
  }

  await p.screenshot({ path: '../../test_preset_filled.png' });
  console.log('filled form screenshot saved');

  // 点击保存
  const saveBtn = p.locator('#preset-form-save');
  await saveBtn.click();
  console.log('clicked save');
  await p.waitForTimeout(2000);
  await p.screenshot({ path: '../../test_preset_saved.png' });
  console.log('saved screenshot saved');

  // 检查 toast
  const toast = await p.evaluate(() => {
    const t = document.querySelector('[class*="toast"]');
    return t ? t.textContent : 'no toast';
  });
  console.log('toast:', toast);

  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
