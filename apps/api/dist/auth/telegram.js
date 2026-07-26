import crypto from 'crypto';
export function verifyTelegramInitData(initData, botToken) { const params = new URLSearchParams(initData); const hash = params.get('hash'); if (!hash)
    return false; const authDate = Number(params.get('auth_date')); if (!authDate)
    return false; if (Math.floor(Date.now() / 1000) - authDate > 86400)
    return false; params.delete('hash'); const dataCheckString = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n'); const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest(); const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'); try {
    return crypto.timingSafeEqual(Buffer.from(calculated, 'hex'), Buffer.from(hash, 'hex'));
}
catch {
    return false;
} }
export function parseTelegramUser(initData) { const raw = new URLSearchParams(initData).get('user'); return raw ? JSON.parse(raw) : null; }
