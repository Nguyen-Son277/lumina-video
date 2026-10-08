import { randomBytes } from 'node:crypto'

// Sinh khóa mã hóa 32 byte cho AES-256-GCM.
const key = randomBytes(32).toString('base64')
console.log(key)
