import json
import os
import boto3
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from boto3.dynamodb.conditions import Key

# Initialize DynamoDB
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['SCORES_TABLE'])

# CORS headers
CORS_HEADERS = {
    'Access-Control-Allow-Origin': os.environ.get('ALLOWED_ORIGIN', '*'),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
}

def lambda_handler(event, context):
    """Main Lambda handler"""
    path = event['path']
    method = event['httpMethod']
    
    try:
        # Route to appropriate handler
        if method == 'OPTIONS':
            return respond(200, {'message': 'OK'})
        
        if path == '/health':
            return handle_health_check()
        elif path == '/scores' and method == 'POST':
            return handle_submit_score(event)
        elif path == '/leaderboard/daily' and method == 'GET':
            return handle_get_leaderboard(event)
        elif path == '/leaderboard/alltime' and method == 'GET':
            return handle_get_alltime_leaderboard(event)
        elif path == '/leaderboard/history' and method == 'GET':
            return handle_get_historical_leaderboard(event)
        elif path.startswith('/scores/') and method == 'GET':
            nickname = event['pathParameters']['nickname']
            return handle_get_player_stats(nickname)
        else:
            return respond(404, {'error': 'Not Found'})
            
    except Exception as e:
        print(f"Error: {str(e)}")
        return respond(500, {'error': 'Internal server error'})

def handle_health_check():
    """Health check endpoint"""
    return respond(200, {'status': 'healthy', 'timestamp': datetime.now(timezone.utc).isoformat()})

def handle_submit_score(event):
    """Submit a new score"""
    try:
        body = json.loads(event['body'])
        nickname = body['nickname']
        score = int(body['score'])
        coins = int(body['coins'])
        gameplay_hash = body.get('gameplay_hash', '')
        game_duration = int(body.get('game_duration', 0))
        
        # Validate the score
        is_valid, message = validate_score(score, coins, game_duration, gameplay_hash)
        if not is_valid:
            return respond(400, {'error': 'invalid_request', 'message': message})
        
        # Get current date
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        
        # Check if this is a new high score for the player today
        current_best = get_player_daily_best(nickname, today)
        
        if current_best and current_best >= score:
            return respond(200, {
                'status': 'rejected',
                'message': 'Score not higher than daily best',
                'data': {
                    'current_best': current_best,
                    'submitted_score': score
                }
            })
        
        # First, delete any existing score for this player today
        # Query for existing entries
        existing_response = table.query(
            KeyConditionExpression=Key('pk').eq(f"DAILY#{today}") & Key('sk').begins_with('SCORE#'),
            FilterExpression='nickname = :nickname',
            ExpressionAttributeValues={':nickname': nickname}
        )
        
        # Delete existing entries for this player
        for existing_item in existing_response.get('Items', []):
            table.delete_item(
                Key={
                    'pk': existing_item['pk'],
                    'sk': existing_item['sk']
                }
            )
        
        # Save the new high score
        timestamp = datetime.now(timezone.utc).isoformat()
        ttl = int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp())
        
        # Create sortable score key (pad score with zeros for proper sorting)
        score_key = f"SCORE#{str(score).zfill(9)}#{nickname}#{timestamp}"
        
        item = {
            'pk': f"DAILY#{today}",
            'sk': score_key,
            'nickname': nickname,
            'score': score,
            'coins': coins,
            'gameplay_hash': gameplay_hash,
            'game_duration': game_duration,
            'timestamp': timestamp,
            'date': today,
            'ttl': ttl
        }
        
        table.put_item(Item=item)
        
        # Check and update all-time high score
        update_alltime_score(nickname, score, coins, timestamp, today)
        
        # Get player's rank
        rank = get_player_rank(today, score)
        
        return respond(200, {
            'status': 'accepted',
            'message': 'New daily high score recorded',
            'data': {
                'previous_best': current_best or 0,
                'new_best': score,
                'rank': rank
            }
        })
        
    except Exception as e:
        print(f"Error submitting score: {str(e)}")
        return respond(400, {'error': 'invalid_request', 'message': 'Invalid request format'})

def handle_get_leaderboard(event):
    """Get daily leaderboard"""
    try:
        # Get query parameters
        params = event.get('queryStringParameters') or {}
        limit = min(int(params.get('limit', 10)), 100)
        offset = int(params.get('offset', 0))
        
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        
        # Query today's scores
        response = table.query(
            KeyConditionExpression=Key('pk').eq(f"DAILY#{today}"),
            ScanIndexForward=False,  # Sort descending
            Limit=limit + offset
        )
        
        items = response['Items'][offset:offset + limit]
        
        # Format leaderboard
        leaderboard = []
        for idx, item in enumerate(items):
            leaderboard.append({
                'rank': offset + idx + 1,
                'nickname': item['nickname'],
                'score': int(item['score']),
                'coins': int(item['coins']),
                'timestamp': item['timestamp']
            })
        
        # Get total players count
        total_response = table.query(
            KeyConditionExpression=Key('pk').eq(f"DAILY#{today}"),
            Select='COUNT'
        )
        
        return respond(200, {
            'date': today,
            'reset_time': f"{(datetime.now(timezone.utc) + timedelta(days=1)).strftime('%Y-%m-%d')}T00:00:00Z",
            'total_players': total_response['Count'],
            'leaderboard': leaderboard
        })
        
    except Exception as e:
        print(f"Error getting leaderboard: {str(e)}")
        return respond(500, {'error': 'Internal server error'})

def handle_get_player_stats(nickname):
    """Get player's daily statistics"""
    try:
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        
        # Query using GSI
        response = table.query(
            IndexName='nickname-date-index',
            KeyConditionExpression=Key('nickname').eq(nickname) & Key('date').eq(today)
        )
        
        if not response['Items']:
            return respond(404, {'error': 'Player not found'})
        
        # Get the best score (items should already be sorted)
        best_score_item = response['Items'][0]
        score = int(best_score_item['score'])
        
        # Get rank
        rank = get_player_rank(today, score)
        
        # Get first play time
        first_play = min(item['timestamp'] for item in response['Items'])
        
        return respond(200, {
            'nickname': nickname,
            'daily_best': {
                'score': score,
                'coins': int(best_score_item['coins']),
                'timestamp': best_score_item['timestamp'],
                'rank': rank
            },
            'attempts_today': len(response['Items']),
            'first_play_today': first_play
        })
        
    except Exception as e:
        print(f"Error getting player stats: {str(e)}")
        return respond(500, {'error': 'Internal server error'})

def validate_score(score, coins, duration, gameplay_hash):
    """Validate submitted score"""
    # Allow very short games (2+ seconds for testing)
    if duration < 2:
        return False, "Game too short"
    
    # Score must be divisible by 10
    if score % 10 != 0:
        return False, "Invalid score increment"
    
    # Maximum theoretical score (normalized to 600 points/second)
    # Allow 10% leeway for timing variations and rounding
    if score > duration * 660:
        return False, "Score impossible for duration"
    
    # Coins can't exceed reasonable spawn rate
    max_possible_coins = score // 100  # Very rough estimate
    if coins > max_possible_coins:
        return False, "Too many coins for score"
    
    # Basic hash validation
    if not gameplay_hash or len(gameplay_hash) < 4:
        return False, "Invalid gameplay hash"
    
    return True, "Valid"

def get_player_daily_best(nickname, date):
    """Get player's best score for the day"""
    response = table.query(
        IndexName='nickname-date-index',
        KeyConditionExpression=Key('nickname').eq(nickname) & Key('date').eq(date),
        ScanIndexForward=False,
        Limit=1
    )
    
    if response['Items']:
        return int(response['Items'][0]['score'])
    return None

def get_player_rank(date, score):
    """Get player's rank for their score"""
    score_key = f"SCORE#{str(score).zfill(9)}"
    response = table.query(
        KeyConditionExpression=Key('pk').eq(f"DAILY#{date}") & Key('sk').gt(score_key),
        ScanIndexForward=False,
        Select='COUNT'
    )
    
    return response['Count'] + 1

def respond(status_code, body):
    """Create API response with CORS headers"""
    return {
        'statusCode': status_code,
        'headers': CORS_HEADERS,
        'body': json.dumps(body, default=str)
    }

def handle_get_alltime_leaderboard(event):
    """Get all-time top scores"""
    try:
        # Get query parameters
        params = event.get('queryStringParameters') or {}
        limit = min(int(params.get('limit', 5)), 20)  # Max 20 for all-time
        
        # Query all-time scores
        response = table.query(
            KeyConditionExpression=Key('pk').eq('ALLTIME'),
            ScanIndexForward=False,  # Sort descending
            Limit=limit
        )
        
        items = response['Items']
        
        # Format leaderboard
        leaderboard = []
        for idx, item in enumerate(items):
            leaderboard.append({
                'rank': idx + 1,
                'nickname': item['nickname'],
                'score': int(item['score']),
                'coins': int(item.get('coins', 0)),
                'date': item.get('date', 'Unknown'),
                'timestamp': item['timestamp']
            })
        
        return respond(200, {
            'leaderboard': leaderboard
        })
        
    except Exception as e:
        print(f"Error getting all-time leaderboard: {str(e)}")
        return respond(500, {'error': 'Internal server error'})

def handle_get_historical_leaderboard(event):
    """Get leaderboard for a specific date"""
    try:
        # Get query parameters
        params = event.get('queryStringParameters') or {}
        date = params.get('date')
        limit = min(int(params.get('limit', 10)), 100)
        offset = int(params.get('offset', 0))
        
        if not date:
            return respond(400, {'error': 'Date parameter is required'})
        
        # Validate date format
        try:
            datetime.strptime(date, '%Y-%m-%d')
        except ValueError:
            return respond(400, {'error': 'Invalid date format. Use YYYY-MM-DD'})
        
        # Query historical scores
        response = table.query(
            KeyConditionExpression=Key('pk').eq(f"DAILY#{date}"),
            ScanIndexForward=False,  # Sort descending
            Limit=limit + offset
        )
        
        items = response['Items'][offset:offset + limit]
        
        # Format leaderboard
        leaderboard = []
        for idx, item in enumerate(items):
            leaderboard.append({
                'rank': offset + idx + 1,
                'nickname': item['nickname'],
                'score': int(item['score']),
                'coins': int(item['coins']),
                'timestamp': item['timestamp']
            })
        
        # Get total players count for that date
        total_response = table.query(
            KeyConditionExpression=Key('pk').eq(f"DAILY#{date}"),
            Select='COUNT'
        )
        
        return respond(200, {
            'date': date,
            'total_players': total_response['Count'],
            'leaderboard': leaderboard
        })
        
    except Exception as e:
        print(f"Error getting historical leaderboard: {str(e)}")
        return respond(500, {'error': 'Internal server error'})

def update_alltime_score(nickname, score, coins, timestamp, date):
    """Update all-time high score if this score qualifies"""
    try:
        # Check if this player already has an all-time entry
        existing_alltime = table.query(
            KeyConditionExpression=Key('pk').eq('ALLTIME'),
            FilterExpression='nickname = :nickname',
            ExpressionAttributeValues={':nickname': nickname}
        )
        
        # If player has existing all-time score, check if new score is higher
        if existing_alltime['Items']:
            existing_score = int(existing_alltime['Items'][0]['score'])
            if score <= existing_score:
                return  # Not a new all-time high for this player
            
            # Delete old all-time entry
            for item in existing_alltime['Items']:
                table.delete_item(
                    Key={
                        'pk': item['pk'],
                        'sk': item['sk']
                    }
                )
        
        # Check if score qualifies for top 100 all-time
        # Get current top 100
        top_scores = table.query(
            KeyConditionExpression=Key('pk').eq('ALLTIME'),
            ScanIndexForward=False,
            Limit=100
        )
        
        # If less than 100 scores or score beats the lowest, add it
        if len(top_scores['Items']) < 100 or (top_scores['Items'] and score > int(top_scores['Items'][-1]['score'])):
            # Create all-time entry
            alltime_item = {
                'pk': 'ALLTIME',
                'sk': f"SCORE#{str(score).zfill(9)}#{nickname}#{timestamp}",
                'nickname': nickname,
                'score': score,
                'coins': coins,
                'timestamp': timestamp,
                'date': date
                # No TTL for all-time scores
            }
            
            table.put_item(Item=alltime_item)
            
            # If we now have more than 100 scores, remove the lowest
            if len(top_scores['Items']) >= 100:
                # Get the new top 100 to find which to remove
                new_top = table.query(
                    KeyConditionExpression=Key('pk').eq('ALLTIME'),
                    ScanIndexForward=False,
                    Limit=101
                )
                
                if len(new_top['Items']) > 100:
                    # Delete the 101st entry
                    to_delete = new_top['Items'][100]
                    table.delete_item(
                        Key={
                            'pk': to_delete['pk'],
                            'sk': to_delete['sk']
                        }
                    )
        
    except Exception as e:
        print(f"Error updating all-time score: {str(e)}")
        # Don't fail the main request if all-time update fails