export function testDatabaseUrls(): { sourceUrl: string; testUrl: string } {
  const sourceUrl = process.env.DB_URL ?? 'postgresql://postgres:postgres@localhost:5432/relaybox_dev';
  const testUrl = new URL(sourceUrl);
  testUrl.pathname = '/relaybox_test';
  return { sourceUrl, testUrl: testUrl.toString() };
}
