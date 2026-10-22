const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('集成测试缺少 DATABASE_URL');
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
if (databaseName !== 'yunshuo_test') {
  throw new Error(`集成测试必须使用独立测试库 yunshuo_test，当前为 ${databaseName}`);
}
