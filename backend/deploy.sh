#!/bin/bash

# Deployment script for Boxy Run backend
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
ALLOWED_ORIGIN="https://unicitynetwork.github.io"

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
        --allowed-origin)
            ALLOWED_ORIGIN="$2"
            shift 2
            ;;
        --help)
            echo "Usage: ./deploy.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --stack-name NAME      CloudFormation stack name (default: boxy-run-backend)"
            echo "  --region REGION        AWS region (default: from AWS config)"
            echo "  --allowed-origin URL   CORS allowed origin (default: https://unicitynetwork.github.io)"
            echo ""
            echo "Example:"
            echo "  ./deploy.sh"
            echo "  ./deploy.sh --allowed-origin https://yourusername.github.io"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

echo -e "${GREEN}=== Boxy Run Backend Deployment ===${NC}"
echo "Stack Name: $STACK_NAME"
echo "Region: $REGION"
echo "Allowed Origin: $ALLOWED_ORIGIN"
echo ""

# Check for required tools
echo -e "${YELLOW}Checking requirements...${NC}"

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI is not installed${NC}"
    echo "Please install AWS CLI: https://aws.amazon.com/cli/"
    exit 1
fi

# Check AWS credentials
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}Error: AWS credentials not configured${NC}"
    echo "Please run: aws configure"
    exit 1
fi

# Check SAM CLI
if ! command -v sam &> /dev/null; then
    echo -e "${RED}Error: AWS SAM CLI is not installed${NC}"
    echo "Please install SAM CLI: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html"
    exit 1
fi

echo -e "${GREEN}✓ All requirements met${NC}"
echo ""

# Create S3 bucket for deployment artifacts (if it doesn't exist)
BUCKET_NAME="sam-deployments-$(aws sts get-caller-identity --query Account --output text)-$REGION"
echo -e "${YELLOW}Checking S3 bucket for deployments...${NC}"

if ! aws s3 ls "s3://$BUCKET_NAME" 2>&1 | grep -q 'NoSuchBucket'; then
    echo "Bucket $BUCKET_NAME already exists"
else
    echo "Creating bucket $BUCKET_NAME..."
    if [ "$REGION" == "me-central-1" ]; then
        aws s3 mb "s3://$BUCKET_NAME" --region $REGION
    else
        aws s3 mb "s3://$BUCKET_NAME" --region $REGION --create-bucket-configuration LocationConstraint=$REGION
    fi
    echo -e "${GREEN}✓ Bucket created${NC}"
fi
echo ""

# Build the application
echo -e "${YELLOW}Building application...${NC}"
cd "$(dirname "$0")"
sam build --template-file template.yaml --region $REGION

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Build successful${NC}"
else
    echo -e "${RED}Build failed${NC}"
    exit 1
fi
echo ""

# Deploy the application
echo -e "${YELLOW}Deploying application...${NC}"
sam deploy \
    --stack-name $STACK_NAME \
    --s3-bucket $BUCKET_NAME \
    --capabilities CAPABILITY_IAM \
    --parameter-overrides AllowedOrigin=$ALLOWED_ORIGIN \
    --region $REGION \
    --no-confirm-changeset

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Deployment successful${NC}"
else
    echo -e "${RED}Deployment failed${NC}"
    exit 1
fi
echo ""

# Get the API endpoint
echo -e "${YELLOW}Getting API endpoint...${NC}"
API_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --region $REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' \
    --output text)

echo -e "${GREEN}✓ API Endpoint: $API_ENDPOINT${NC}"
echo ""

# Update the game configuration
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Update your game.js file to use the API endpoint:"
echo "   Replace: https://api.example.com/v1/boxyrun"
echo "   With: $API_ENDPOINT"
echo ""
echo "2. If using a custom domain, update --allowed-origin:"
echo "   ./deploy.sh --allowed-origin https://yourusername.github.io"
echo ""
echo "3. Test the API:"
echo "   curl $API_ENDPOINT/health"
echo ""

# Test the health endpoint
echo -e "${YELLOW}Testing health endpoint...${NC}"
if curl -s "$API_ENDPOINT/health" | grep -q "healthy"; then
    echo -e "${GREEN}✓ API is healthy${NC}"
else
    echo -e "${RED}API health check failed${NC}"
fi

echo ""
echo -e "${GREEN}=== Deployment Complete ===${NC}"