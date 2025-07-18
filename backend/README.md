# Boxy Run Backend

AWS Lambda + DynamoDB backend for the Boxy Run game leaderboard system.

## Architecture

- **API Gateway**: REST API with CORS support
- **Lambda**: Python 3.9 function handling all endpoints
- **DynamoDB**: Pay-per-request pricing model
- **TTL**: Automatic cleanup of records after 7 days

## Cost Estimate

For typical usage (1000 players/day, 10 games each):
- **DynamoDB**: ~$0.25/month (pay-per-request)
- **Lambda**: ~$0.00/month (within free tier)
- **API Gateway**: ~$0.04/month (first 1M requests free)
- **Total**: Less than $1/month

## Deployment

### Prerequisites
- AWS CLI installed and configured
- AWS SAM CLI installed
- AWS account with appropriate permissions

### Deploy

```bash
# Deploy with default settings
./deploy.sh

# Deploy with custom origin for CORS
./deploy.sh --allowed-origin https://yourusername.github.io

# Deploy to specific region
./deploy.sh --region eu-west-1

# Full example
./deploy.sh \
  --stack-name my-game-backend \
  --region us-west-2 \
  --allowed-origin https://myusername.github.io
```

### Update Game

After deployment, update your `game.js`:

```javascript
// Replace this:
fetch('https://api.example.com/v1/boxyrun/scores', {

// With your actual endpoint:
fetch('https://YOUR-API-ID.execute-api.me-central-1.amazonaws.com/prod/scores', {
```

## API Endpoints

### POST /scores
Submit a new score (only if higher than daily best)

### GET /leaderboard/daily
Get today's top scores

### GET /scores/{nickname}
Get a player's daily statistics

### GET /health
Health check endpoint

## DynamoDB Schema

### Primary Key
- **pk**: `DAILY#2024-07-16` (partition by day)
- **sk**: `SCORE#000015420#Player-123` (sorted by score)

### Global Secondary Index
- **nickname-date-index**: Query by player nickname

### TTL
- Records automatically deleted after 7 days
- Keeps costs low and data fresh

## Security

- Input validation on all scores
- Gameplay hash verification
- No rate limiting (players can retry quickly)
- CORS restricted to your domain

## Monitoring

CloudWatch Logs are retained for 7 days. Monitor:
- Invalid score submissions
- Error rates
- Response times

## Cleanup

### Quick Teardown

```bash
# Remove all backend resources (including deployment bucket)
./teardown.sh

# Keep the deployment bucket for future use
./teardown.sh --keep-bucket

# Teardown with custom stack name
./teardown.sh --stack-name my-game-backend
```

### What Gets Deleted
- API Gateway endpoints
- Lambda function  
- DynamoDB table (all score data)
- CloudWatch logs
- Optionally: SAM deployment bucket

### Manual Cleanup

If you prefer AWS CLI:

```bash
aws cloudformation delete-stack --stack-name boxy-run-backend --region me-central-1
```