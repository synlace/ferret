variable "aws_region" {
  type        = string
  default     = "eu-west-1"
  description = "The AWS region to deploy resources into"
}

variable "environment" {
  type        = string
  default     = "dev"
  description = "Deployment environment name (e.g., dev, staging, prod)"
}

variable "wireguard_port" {
  type        = number
  default     = 51820
  description = "The UDP port for WireGuard tunnel communication"
}

variable "hub_priv" {
  type        = string
  default     = ""
  description = "WireGuard Hub Private Key"
  sensitive   = true
}

variable "local_pub" {
  type        = string
  default     = ""
  description = "WireGuard Client Public Key"
}
