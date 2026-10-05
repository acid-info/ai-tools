export const API = {
  github: {
    baseUrl: 'https://api.github.com',
    gitUrl: 'https://github.com',
    version: '2026-03-10',
    accept: 'application/vnd.github+json',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    version: '2023-06-01',
    messagesPath: '/v1/messages',
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    responsesPath: '/v1/responses',
  },
};
