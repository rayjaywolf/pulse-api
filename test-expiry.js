import { Pool } from "pg";
import "dotenv/config";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://neondb_owner:npg_0fUIGJYzwK3b@ep-misty-mouse-advrd4e3-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

const pgPool = new Pool({
  connectionString: DATABASE_URL,
});

async function testExpirySystem() {
  try {
    console.log("🧪 Testing License Expiry System");

    const testKey = `test-expired-${Date.now()}`;
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    await pgPool.query(
      `INSERT INTO licenses (license_key, tier, created_at, expires_at, revoked)
       VALUES ($1, 'monthly', NOW(), $2, false)`,
      [testKey, oneDayAgo]
    );
    console.log(`✓ Created expired test license: ${testKey}`);

    let result = await pgPool.query(
      `SELECT revoked, expires_at FROM licenses WHERE license_key = $1`,
      [testKey]
    );
    console.log(
      `✓ License revoked status before expiry job: ${result.rows[0].revoked}`
    );

      const updateResult = await pgPool.query(
      `UPDATE licenses 
       SET revoked = true 
       WHERE expires_at <= NOW() 
       AND revoked = false`
    );
    console.log(
      `✓ Expiry job processed ${updateResult.rowCount} expired licenses`
    );

    result = await pgPool.query(
      `SELECT revoked, expires_at FROM licenses WHERE license_key = $1`,
      [testKey]
    );
    console.log(
      `✓ License revoked status after expiry job: ${result.rows[0].revoked}`
    );

        const statusResponse = await fetch(
      `http://localhost:4000/license/status?key=${testKey}`
    );
    const statusData = await statusResponse.json();
    console.log(`✓ Status endpoint response:`, statusData);

    await pgPool.query(`DELETE FROM licenses WHERE license_key = $1`, [
      testKey,
    ]);
    console.log(`✓ Cleaned up test license`);

    console.log("🎉 Expiry system test completed successfully!");
  } catch (err) {
    console.error("❌ Test failed:", err);
  } finally {
    await pgPool.end();
    process.exit(0);
  }
}

testExpirySystem();
