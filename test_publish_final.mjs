import { TiktokPublisher } from './src/tiktok/tiktok-publisher.js';

const wsUrl = 'ws://127.0.0.1:7539/devtools/browser/e37d3f34-1cee-4889-a9e1-856294f41d3e';
const filePath = 'D:/Download/mmexport1789272791126.mp4';

(async () => {
  console.log('=== TikTok 发布测试 ===');
  const publisher = new TiktokPublisher();
  
  try {
    console.log('[1] 连接 CDP (browser-level)...');
    const connResult = await publisher.connect(wsUrl);
    console.log('连接结果:', connResult);

    console.log('[2] 上传视频...');
    const result = await publisher.uploadVideo({
      filePath,
      title: 'Test upload',
      hashtags: [],
      privacyLevel: 'public',
    });
    
    console.log('[3] 发布结果:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('❌ 错误:', e.message);
  }
})();
