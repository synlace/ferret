terraform {
  required_version = ">= 1.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "aws" {
  region = var.aws_region
}

# 1. VPC & Networking Setup
resource "aws_vpc" "ferret_vpc" {
  cidr_block           = "172.31.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "ferret-vpc-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_subnet" "ferret_subnet_a" {
  vpc_id                  = aws_vpc.ferret_vpc.id
  cidr_block              = "172.31.1.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true

  tags = {
    Name        = "ferret-public-subnet-a"
    Environment = var.environment
  }
}

resource "aws_internet_gateway" "ferret_igw" {
  vpc_id = aws_vpc.ferret_vpc.id

  tags = {
    Name        = "ferret-igw"
    Environment = var.environment
  }
}

resource "aws_route_table" "ferret_rt" {
  vpc_id = aws_vpc.ferret_vpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.ferret_igw.id
  }

  tags = {
    Name        = "ferret-route-table"
    Environment = var.environment
  }
}

resource "aws_route_table_association" "ferret_rta" {
  subnet_id      = aws_subnet.ferret_subnet_a.id
  route_table_id = aws_route_table.ferret_rt.id
}

# 2. Security Groups
# EC2 Security Group: Allows inbound WireGuard (UDP 51820) and inbound Nginx (TCP 80) from Fargate scanners
resource "aws_security_group" "ferret_ec2_wg_sg" {
  name        = "ferret-ec2-wg-sg"
  description = "Security Group for WireGuard VPN Hub EC2 instance"
  vpc_id      = aws_vpc.ferret_vpc.id

  # Inbound WireGuard (UDP)
  ingress {
    from_port   = var.wireguard_port
    to_port     = var.wireguard_port
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Inbound API (TCP 80) from Fargate runners
  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.ferret_runner_outbound_sg.id]
  }

  # Outbound access
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "ferret-ec2-wg-sg"
    Environment = var.environment
  }
}

# Fargate Security Group: Outbound-only to let scanners reach target hosts and the WireGuard Hub
resource "aws_security_group" "ferret_runner_outbound_sg" {
  name        = "ferret-runner-outbound-sg"
  description = "Outbound-only security group for ephemeral Fargate scanners"
  vpc_id      = aws_vpc.ferret_vpc.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "ferret-runner-outbound-sg"
    Environment = var.environment
  }
}

# 3. IAM Roles & Policies
# Task Execution and Task Role for Fargate Task Runners
resource "aws_iam_role" "ferret_execution_role" {
  name = "ferretExecutionRole"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ferret_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy_attachment" "cw_logs" {
  role       = aws_iam_role.ferret_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchLogsFullAccess"
}

# ECS Exec Systems Manager Policy (enables secure, interactive shell sessions on task containers)
resource "aws_iam_policy" "ecs_exec" {
  name        = "ferretECSExecPolicy"
  description = "Allows ECS Tasks to communicate with AWS Systems Manager for ECS Exec"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_exec_attachment" {
  role       = aws_iam_role.ferret_execution_role.name
  policy_arn = aws_iam_policy.ecs_exec.arn
}

# EC2 Instance Discovery Policy (allows the ferret-api container to discover EC2 private IP)
resource "aws_iam_policy" "ec2_discovery" {
  name        = "ferretEC2InstanceDiscovery"
  description = "Allows API container to auto-discover WireGuard EC2 Hub Private IPs"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances"
        ]
        Resource = "*"
      }
    ]
  })
}

# 4. WireGuard Hub EC2 Instance
# Select the latest Debian 12 AMI
data "aws_ami" "debian_12" {
  most_recent = true
  owners      = ["136693071363"] # Debian Official

  filter {
    name   = "name"
    values = ["debian-12-amd64-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_instance" "ferret_wg_hub" {
  ami                    = data.aws_ami.debian_12.id
  instance_type          = "t3.nano"
  subnet_id              = aws_subnet.ferret_subnet_a.id
  vpc_security_group_ids = [aws_security_group.ferret_ec2_wg_sg.id]

  # Cloud-Init UserData: Installs WG + Nginx + configures routing and reverse proxy
  user_data = <<-EOF
              #!/bin/bash
              set -e
              apt-get update
              DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard nginx iptables jq

              mkdir -p /etc/wireguard
              cat <<EOWG > /etc/wireguard/wg0.conf
              [Interface]
              PrivateKey = ${var.hub_priv}
              ListenPort = 51820
              Address = 10.0.0.1/24
              MTU = 1280

              [Peer]
              PublicKey = ${var.local_pub}
              AllowedIPs = 10.0.0.2/32
              EOWG

              # Standard routing setup
              echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
              sysctl -p || sysctl --system

              # Configure default site reverse-proxy pointing to the WireGuard client tunnel IP (10.0.0.2)
              cat <<'EON' > /etc/nginx/sites-available/default
              server {
                  listen 80 default_server;
                  location / {
                      proxy_pass http://10.0.0.2:8000;
                      proxy_set_header Host $host;
                      proxy_set_header X-Real-IP $remote_addr;
                      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                      proxy_set_header X-Forwarded-Proto $scheme;
                      proxy_http_version 1.1;
                      proxy_set_header Upgrade $http_upgrade;
                      proxy_set_header Connection "upgrade";
                  }
              }
              EON

              systemctl restart nginx
              systemctl enable wg-quick@wg0
              systemctl start wg-quick@wg0
              EOF

  tags = {
    Name        = "ferret-wg-hub"
    Environment = var.environment
  }
}

# 5. ECS Cluster & Log Group
resource "aws_ecs_cluster" "ferret_runners" {
  name = "ferret-runners"
}




