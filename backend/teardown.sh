#!/bin/bash

# Teardown script for Boxy Run backend
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default values
STACK_NAME="boxy-run-backend"
# Get region from AWS config or environment
REGION=$(aws configure get region 2>/dev/null || echo ${AWS_REGION:-"me-central-1"})
DELETE_BUCKET=true

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --stack-name)
            STACK_NAME="$2"
            shift 2
            ;;
        --region)
            REGION="$2"
            shift 2
            ;;
        --keep-bucket)
            DELETE_BUCKET=false
            shift
            ;;
        --help)
            echo "Usage: ./teardown.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --stack-name NAME      CloudFormation stack name (default: boxy-run-backend)"
            echo "  --region REGION        AWS region (default: from AWS config)"
            echo "  --keep-bucket          Keep the SAM deployment bucket (default: delete it)"
            echo ""
            echo "Example:"
            echo "  ./teardown.sh"
            echo "  ./teardown.sh --keep-bucket"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

echo -e "${GREEN}=== Boxy Run Backend Teardown ===${NC}"
echo "Stack Name: $STACK_NAME"
echo "Region: $REGION"
echo "Delete SAM Bucket: $DELETE_BUCKET"
echo ""

# Check for required tools
echo -e "${YELLOW}Checking requirements...${NC}"

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI is not installed${NC}"
    exit 1
fi

# Check AWS credentials
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}Error: AWS credentials not configured${NC}"
    exit 1
fi

echo -e "${GREEN}✓ All requirements met${NC}"
echo ""

# Check if stack exists
echo -e "${YELLOW}Checking if stack exists...${NC}"
if ! aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION &> /dev/null; then
    echo -e "${RED}Stack '$STACK_NAME' not found in region $REGION${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Stack found${NC}"
echo ""

# Confirm deletion
echo -e "${YELLOW}WARNING: This will delete all resources including:${NC}"
echo "  - API Gateway"
echo "  - Lambda Function"
echo "  - DynamoDB Table (with all score data)"
echo "  - CloudWatch Logs"
echo ""
read -p "Are you sure you want to delete the stack? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo -e "${YELLOW}Teardown cancelled${NC}"
    exit 0
fi

# Delete the stack
echo ""
echo -e "${YELLOW}Deleting CloudFormation stack...${NC}"
aws cloudformation delete-stack \
    --stack-name $STACK_NAME \
    --region $REGION

echo "Waiting for stack deletion to complete..."
aws cloudformation wait stack-delete-complete \
    --stack-name $STACK_NAME \
    --region $REGION

echo -e "${GREEN}✓ Stack deleted successfully${NC}"

# Optionally delete the S3 bucket
if [ "$DELETE_BUCKET" = true ]; then
    echo ""
    echo -e "${YELLOW}Deleting SAM deployment bucket...${NC}"
    BUCKET_NAME="sam-deployments-$(aws sts get-caller-identity --query Account --output text)-$REGION"
    
    if aws s3 ls "s3://$BUCKET_NAME" 2>&1 | grep -q 'NoSuchBucket'; then
        echo "Bucket $BUCKET_NAME doesn't exist"
    else
        # Empty the bucket first
        echo "Emptying bucket $BUCKET_NAME..."
        aws s3 rm "s3://$BUCKET_NAME" --recursive
        
        # Delete the bucket
        echo "Deleting bucket $BUCKET_NAME..."
        aws s3 rb "s3://$BUCKET_NAME"
        echo -e "${GREEN}✓ Bucket deleted${NC}"
    fi
fi

echo ""
echo -e "${GREEN}=== Teardown Complete ===${NC}"
echo ""
echo -e "${YELLOW}What was removed:${NC}"
echo "  ✓ API Gateway endpoints"
echo "  ✓ Lambda function"
echo "  ✓ DynamoDB table and all data"
echo "  ✓ CloudWatch log groups"
if [ "$DELETE_BUCKET" = true ]; then
    echo "  ✓ SAM deployment bucket"
fi
echo ""
echo "To redeploy, run: ./deploy.sh"