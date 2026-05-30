output "vpc_id" {
  value       = aws_vpc.ferret_vpc.id
  description = "The ID of the VPC"
}

output "subnet_id" {
  value       = aws_subnet.ferret_subnet_a.id
  description = "The public Subnet ID for task launches"
}

output "security_group_id" {
  value       = aws_security_group.ferret_runner_outbound_sg.id
  description = "The Security Group ID for the Fargate tasks"
}

output "execution_role_arn" {
  value       = aws_iam_role.ferret_execution_role.arn
  description = "The Execution/Task Role ARN for ECS tasks"
}

output "hub_private_ip" {
  value       = aws_instance.ferret_wg_hub.private_ip
  description = "The Private IP of the EC2 WireGuard Hub inside the VPC"
}

output "hub_public_ip" {
  value       = aws_instance.ferret_wg_hub.public_ip
  description = "The Public IP of the EC2 WireGuard Hub"
}

