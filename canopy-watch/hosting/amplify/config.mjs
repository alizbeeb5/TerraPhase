function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error('Set build variable ' + name + ' before packaging TerraPhase for Amplify.');
  return value;
}

export function readBuildConfig(env) {
  const origin = new URL(required(env, 'TERRAPHASE_PUBLIC_ORIGIN'));
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('TERRAPHASE_PUBLIC_ORIGIN must be a bare HTTPS origin.');
  }
  const secretArn = required(env, 'TERRAPHASE_SECRET_ARN');
  const secret = /^arn:aws:secretsmanager:([a-z0-9-]+):\d{12}:secret:[\w/+=.@-]+$/.exec(secretArn);
  if (!secret) throw new Error('TERRAPHASE_SECRET_ARN must be a Secrets Manager ARN.');
  const limitTable = required(env, 'TERRAPHASE_LIMIT_TABLE');
  if (!/^[a-zA-Z0-9_.-]{3,255}$/.test(limitTable)) throw new Error('TERRAPHASE_LIMIT_TABLE must be a DynamoDB table name.');
  const dailyLimit = Number(env.TERRAPHASE_DAILY_REPORT_LIMIT ?? 120);
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1) throw new Error('TERRAPHASE_DAILY_REPORT_LIMIT must be a positive integer.');
  return { origin: origin.origin, secretArn, region: secret[1], limitTable, dailyLimit };
}
