export function isExchangeAdmin(telegramId: string | bigint | number | null | undefined) {
	const ids = String(process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || '')
		.split(',')
		.map((x) => x.trim())
		.filter(Boolean)
	return ids.includes(String(telegramId || ''))
}
