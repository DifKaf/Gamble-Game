// Выводит ID анимированных эмодзи из набора Telegram.
// Имя набора — конец ссылки t.me/addemoji/<ИМЯ>.
//   npm run emoji:pack -- ИМЯ
// Результат — готовый JSON для TELEGRAM_CUSTOM_EMOJI (первый стикер на каждый эмодзи).
import 'dotenv/config'

const name = String(process.argv[2] || '').replace(/^https?:\/\/t\.me\/addemoji\//, '').trim()
const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim()
if (!name || !token) {
	console.error('Использование: npm run emoji:pack -- <имя_набора>  (нужен TELEGRAM_BOT_TOKEN в .env)')
	process.exit(1)
}
const res = await fetch(`https://api.telegram.org/bot${token}/getStickerSet?name=${encodeURIComponent(name)}`)
const body: any = await res.json()
if (!body.ok) { console.error('Telegram:', body.description); process.exit(1) }
const map: Record<string, string> = {}
for (const st of body.result.stickers || []) {
	if (st.custom_emoji_id && st.emoji && !map[st.emoji]) map[st.emoji] = st.custom_emoji_id
}
console.log(`Набор "${body.result.title}": ${Object.keys(map).length} эмодзи\n`)
for (const st of body.result.stickers || []) console.log(st.emoji, st.custom_emoji_id)
console.log('\nTELEGRAM_CUSTOM_EMOJI=' + JSON.stringify(map))
