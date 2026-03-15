export type GoogleCredentials = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  redirectPort: number;
};

export type GoogleServiceOptions = {
  credentials: GoogleCredentials;
  token?: string;
};
