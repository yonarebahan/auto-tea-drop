require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const axios = require("axios");
const path = require("path");
const { chromium } = require("playwright");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const accounts = process.env.ACCOUNTS?.split(",").map(a => a.trim()).filter(Boolean) || [];

function escapeMarkdownV2(text) {
    return text
        .replace(/_/g, '\\_')
        .replace(/\*/g, '\\*')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/~/g, '\\~')
        .replace(/`/g, '\\`')
        .replace(/>/g, '\\>')
        .replace(/#/g, '\\#')
        .replace(/\+/g, '\\+')
        .replace(/-/g, '\\-')
        .replace(/=/g, '\\=')
        .replace(/\|/g, '\\|')
        .replace(/{/g, '\\{')
        .replace(/}/g, '\\}')
        .replace(/\./g, '\\.')
        .replace(/!/g, '\\!');
}

async function sendTelegramMessage(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const safeMessage = escapeMarkdownV2(message);
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: safeMessage,
            parse_mode: "MarkdownV2"
        });
    } catch (error) {
        console.error("❌ Telegram Error:", error.response?.data || error.message);
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay() {
    const min = 15000;
    const max = 20000;
    const delayTime = Math.floor(Math.random() * (max - min + 1)) + min;
    console.log(`⏱️ Delay ${(delayTime / 1000).toFixed(1)}s sebelum transaksi berikutnya...`);
    return delay(delayTime);
}

function randomDelayMs(min = 25000, max = 35000) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function readAddressesFromFile(filename) {
    if (!fs.existsSync(filename)) return [];
    const data = fs.readFileSync(filename, 'utf8');
    return data.split('\n').map(line => line.trim().toLowerCase()).filter(Boolean);
}

function writeAddressesToFile(filename, addresses) {
    fs.writeFileSync(filename, addresses.join('\n'), 'utf8');
}

async function scrapeFromAddresses(minimum = 115) {
    console.log("🌐 Scraping alamat dari explorer...");
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto("https://sepolia.tea.xyz/txs", { timeout: 60000 });

    const unique = new Set();
    let attempts = 0;

    while (unique.size < minimum) {
        attempts++;
        await page.reload({ waitUntil: 'networkidle' });
        await delay(10000);

        const addresses = await page.$$eval("a[href^='/address/']", (els) => {
            return els
                .map((el, index) => {
                    if (index % 2 === 0) {
                        const addr = el.getAttribute("href").replace("/address/", "").trim().toLowerCase();
                        return addr.startsWith("0x") && addr.length === 42 ? addr : null;
                    }
                    return null;
                })
                .filter(Boolean);
        });

        addresses.forEach(addr => unique.add(addr));
        console.log(`🔄 Percobaan ${attempts}: ${unique.size} alamat terkumpul`);
    }

    await browser.close();
    const result = [...unique];
    console.log(`🔍 Ditemukan total ${result.length} alamat unik`);
    return result;
}

async function runForAccount(accountName, index) {
    const prefix = accountName.toUpperCase();
    const PRIVATE_KEY = process.env[`${prefix}_PRIVATE_KEY`];
    const RPC_URL = process.env[`${prefix}_RPC_URL`];
    const TOKEN_ADDRESS = process.env[`${prefix}_TOKEN_ADDRESS`];

    if (!PRIVATE_KEY || !RPC_URL || !TOKEN_ADDRESS) {
        console.error(`❌ Konfigurasi tidak lengkap untuk ${accountName}`);
        return;
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const token = new ethers.Contract(TOKEN_ADDRESS, [
        "function transfer(address to, uint256 amount) public returns (bool)",
        "function decimals() view returns (uint8)"
    ], wallet);

    try {
        const decimals = await token.decimals();
        const getRandomTokenAmount = (decimals) => {
            const min = 100;
            const max = 1000;
            const randomAmount = (Math.random() * (max - min) + min).toFixed(4);
            return ethers.parseUnits(randomAmount, decimals);
        };

        const sentFile = path.join("accounts", `${accountName}_sent.txt`);
        const pendingFile = path.join("accounts", `${accountName}_pending.txt`);
        const sent = readAddressesFromFile(sentFile);

        const allFroms = await scrapeFromAddresses(115);
        const recipients = allFroms.filter(addr => !sent.includes(addr)).slice(0, 150);

        if (recipients.length === 0) {
            console.log(`✅ [${accountName}] Tidak ada alamat baru.`);
            await sendTelegramMessage(`✅ *Akun ${index + 1}* (${accountName}) tidak ada alamat baru.`);
            return;
        }

        const total = Math.min(recipients.length, Math.floor(Math.random() * 21) + 105);
        const selected = recipients.slice(0, total);
        const failed = [];

        await sendTelegramMessage(`📦 *Akun ${index + 1}* (${accountName}) akan mengirim ke *${total}* alamat.`);

        for (let i = 0; i < selected.length; i++) {
            const recipient = selected[i];
            try {
                if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
                    console.log(`⚠️ [${accountName}] Alamat tidak valid, dilewati: ${recipient}`);
                    continue;
                }

                const amount = getRandomTokenAmount(decimals);
                const tx = await token.transfer(recipient, amount);

                // ⏳ Delay acak 10–15 detik sebelum tx.wait()
                const preWaitDelay = randomDelayMs(10000, 15000);
                console.log(`⏳ Delay ${(preWaitDelay / 1000).toFixed(1)} detik sebelum tx.wait()...`);
                await delay(preWaitDelay);

                let receipt = null;
                let retryCount = 0;


                while (!receipt) {
                    try {
                        receipt = await tx.wait();
                    } catch (waitErr) {
                        const errMsg = waitErr?.error?.message || waitErr?.message || String(waitErr);
                        const retryable =
                            errMsg.includes("429") ||
                            errMsg.includes("enhance_your_calm") ||
                            errMsg.includes("Service Unavailable") ||
                            waitErr.code === 'SERVER_ERROR';

                        if (retryable) {
                            retryCount++;
                            const delayMs = randomDelayMs();
                            console.log(`🔁 [${accountName}] tx.wait() retry ${retryCount}: ${errMsg}`);
                            console.log(`⏳ Delay ${(delayMs / 1000).toFixed(1)} detik sebelum retry...`);
                            await delay(delayMs);
                        } else {
                            throw waitErr;
                        }
                    }
                }

                console.log(`✅ [${accountName}] ${i + 1}/${total} → ${recipient} (${ethers.formatUnits(amount, decimals)} token)`);
                sent.push(recipient);
            } catch (err) {
                const errMsg = err.message || String(err);
                if (errMsg.includes("ENS")) {
                    console.log(`⚠️ [${accountName}] Gagal ke ${recipient} (ENS tidak didukung, dilewati)`);
                } else {
                    console.log(`❌ [${accountName}] Gagal ke ${recipient}: ${errMsg}`);
                    await sendTelegramMessage(
                        `❌ *Akun ${index + 1}* (${accountName}) gagal ke \`${recipient}\`\n_Error:_ ${escapeMarkdownV2(errMsg)}`
                    );
                    failed.push(recipient);
                }
            }

            await randomDelay();
        }

        writeAddressesToFile(sentFile, sent);
        writeAddressesToFile(pendingFile, failed);
        await sendTelegramMessage(`✅ *Akun ${index + 1}* (${accountName}) selesai transfer.`);
    } catch (e) {
        const errMsg = e.message || String(e);
        console.error(`❌ [${accountName}] Error fatal:`, errMsg);
        await sendTelegramMessage(`❌ *Akun ${index + 1}* (${accountName}) error: ${escapeMarkdownV2(errMsg)}`);
    }
}

async function runAllAccounts() {
    await sendTelegramMessage("🚀 *Script TeaTransfer dimulai*!");
    for (let i = 0; i < accounts.length; i++) {
        await runForAccount(accounts[i], i);
    }
    await sendTelegramMessage("✅ *Semua akun selesai transfer hari ini.*");
}

function getRandomExecutionTime() {
    const now = new Date();
    const startUTC = 2; // 09:00 WIB
    const endUTC = 5;   // 12:00 WIB

    const hour = Math.floor(Math.random() * (endUTC - startUTC + 1)) + startUTC;
    const minute = Math.floor(Math.random() * 60);

    const target = new Date();
    target.setUTCHours(hour, minute, 0, 0);
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);

    const ms = target - now;
    console.log(`📅 Script dijadwalkan untuk ${target.toLocaleTimeString('id-ID')} WIB`);
    return ms;
}

async function scheduleDailyExecution() {
    while (true) {
        const delayMs = getRandomExecutionTime();
        const time = new Date(Date.now() + delayMs);
        console.log(`🕒 Menunggu hingga ${time.toLocaleTimeString('id-ID')} WIB...`);
        await delay(delayMs);
        await runAllAccounts();
        console.log("✅ Selesai. Menjadwalkan hari berikutnya...");
    }
}

const args = process.argv.slice(2);
if (args.includes('--now')) {
    (async () => {
        console.log("🚀 Menjalankan sekarang karena ada flag '--now'");
        await runAllAccounts();
        await scheduleDailyExecution();
    })();
} else {
    scheduleDailyExecution();
}
