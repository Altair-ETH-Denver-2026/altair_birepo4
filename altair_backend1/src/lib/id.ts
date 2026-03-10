import crypto from 'crypto';

export async function generateID(): Promise<string> {
  return crypto.randomBytes(16).toString('hex');
}

export async function generateUserID(): Promise<string> {
  const base_UID = await generateID();
  return `0u${base_UID}`;
}

export async function generateChatID(): Promise<string> {
  const base_CID = await generateID();
  return `0c${base_CID}`;
}

export async function generateSwapID(): Promise<string> {
  const base_SID = await generateID();
  return `0s${base_SID}`;
}
