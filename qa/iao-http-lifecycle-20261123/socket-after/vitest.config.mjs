export default {
 root: "/tmp/iao-http-native-green-20261123",
 css: { postcss: { plugins: [] } },
 test: {
  environment: "node", maxWorkers: 1, fileParallelism: false,
  setupFiles: ["/workspace/scratch/ccfbf7e5800b/purama-ai/karta/test/setup.ts"],
  testTimeout: 25000, hookTimeout: 3000,
  include: ["socket-green.test.ts"],
 }
};
