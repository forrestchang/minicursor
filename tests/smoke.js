#!/usr/bin/env node
/**
 * Smoke test for MiniCursor
 * - Starts the server
 * - Waits for it to be ready
 * - Tests /api/meta endpoint
 * - Shuts down
 */

import { spawn } from "node:child_process";
import http from "node:http";

const PORT = 9999;
const TIMEOUT = 30000;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testEndpoint(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${PORT}${path}`, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

async function runSmokeTest() {
  console.log("🧪 Starting smoke test...");
  console.log(`   PORT=${PORT}`);
  
  // Start server
  const server = spawn("node", ["server/index.js"], {
    env: { ...process.env, PORT: String(PORT), ANTHROPIC_API_KEY: "dummy-key" },
    stdio: "pipe",
  });
  
  let output = "";
  server.stdout.on("data", d => {
    const text = d.toString();
    output += text;
    process.stdout.write(text);
  });
  server.stderr.on("data", d => {
    const text = d.toString();
    output += text;
    process.stderr.write(text);
  });
  
  // Wait for server to start
  console.log("⏳ Waiting for server to start...");
  const startTime = Date.now();
  let ready = false;
  
  while (Date.now() - startTime < TIMEOUT) {
    if (output.includes(`listening on http://localhost:${PORT}`)) {
      ready = true;
      break;
    }
    await wait(100);
  }
  
  if (!ready) {
    console.error("❌ Server failed to start within timeout");
    server.kill();
    process.exit(1);
  }
  
  console.log("✅ Server started");
  
  // Run tests
  const tests = [
    { name: "GET /api/meta", fn: () => testEndpoint("/api/meta") },
    { name: "GET /api/tree", fn: () => testEndpoint("/api/tree") },
    { name: "GET / (static)", fn: () => testEndpoint("/") },
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    try {
      const result = await test.fn();
      if (result.status >= 200 && result.status < 300) {
        console.log(`✅ ${test.name} - ${result.status}`);
        passed++;
      } else {
        console.log(`❌ ${test.name} - ${result.status}`);
        failed++;
      }
    } catch (err) {
      console.log(`❌ ${test.name} - ${err.message}`);
      failed++;
    }
  }
  
  // Cleanup
  console.log("🧹 Shutting down server...");
  server.kill();
  
  await new Promise(resolve => {
    server.on("close", resolve);
    setTimeout(() => {
      server.kill("SIGKILL");
      resolve();
    }, 5000);
  });
  
  // Summary
  console.log("");
  console.log(`📊 Results: ${passed} passed, ${failed} failed`);
  
  if (failed > 0) {
    process.exit(1);
  }
  console.log("🎉 Smoke test passed!");
}

runSmokeTest().catch(err => {
  console.error("💥 Smoke test error:", err.message);
  process.exit(1);
});
