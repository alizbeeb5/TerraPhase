import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const secondsPerDay = 86400;

export function createDailyLimit(client, { limitTable, dailyLimit }, now = Date.now) {
  let exhaustedDay;
  return async () => {
    const day = Math.floor(now() / 1000 / secondsPerDay);
    if (day === exhaustedDay) return false;
    try {
      await client.send(new UpdateItemCommand({
        TableName: limitTable,
        Key: { bucket: { S: 'reports:' + day } },
        UpdateExpression: 'SET expiresAt = :expires ADD #used :one',
        ConditionExpression: 'attribute_not_exists(#used) OR #used < :limit',
        ExpressionAttributeNames: { '#used': 'used' },
        ExpressionAttributeValues: {
          ':expires': { N: String((day + 2) * secondsPerDay) },
          ':one': { N: '1' },
          ':limit': { N: String(dailyLimit) },
        },
      }), { abortSignal: AbortSignal.timeout(5000) });
      return true;
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') {
        exhaustedDay = day;
        return false;
      }
      throw error;
    }
  };
}
