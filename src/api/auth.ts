import { OAuth2Client } from 'google-auth-library';
import { GoogleCredentials, GoogleServiceOptions } from '@/types';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

function makeClient(credentials: GoogleCredentials): OAuth2Client {
  return new OAuth2Client(
    credentials.clientId,
    credentials.clientSecret,
    credentials.redirectUri,
  );
}

/**
 * Returns an authenticated OAuth2Client for API calls.
 * The client automatically refreshes expired access tokens.
 */
export async function getAuthClient(
  { credentials, token }: GoogleServiceOptions,
): Promise<OAuth2Client | undefined> {
  if (!token) return undefined;

  try {
    const client = makeClient(credentials);
    client.setCredentials(JSON.parse(token));
    return client;
  } catch (err) {
    console.error('[gcal-sync] Failed to build auth client:', err);
    return undefined;
  }
}

/** Generates the Google OAuth consent URL. */
export async function getAuthUrl(credentials: GoogleCredentials): Promise<string> {
  const client = makeClient(credentials);
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // force refresh_token on every auth
  });
}

/** Exchanges an auth code for tokens; returns serialised token JSON. */
export async function exchangeCodeForToken(
  credentials: GoogleCredentials,
  code: string,
): Promise<string | undefined> {
  try {
    const client = makeClient(credentials);
    const { tokens } = await client.getToken(code);
    return JSON.stringify(tokens);
  } catch (err) {
    console.error('[gcal-sync] Token exchange failed:', err);
    return undefined;
  }
}

/** Returns the authenticated user's email address. */
export async function getAccountEmail(
  { credentials, token }: GoogleServiceOptions,
): Promise<string | undefined> {
  const client = await getAuthClient({ credentials, token });
  if (!client) return undefined;

  try {
    const info = await client.getTokenInfo(
      (await client.getAccessToken()).token ?? '',
    );
    return info.email;
  } catch {
    return undefined;
  }
}
