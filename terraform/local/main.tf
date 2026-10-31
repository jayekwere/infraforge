terraform {
  required_version = ">= 1.15.8, < 1.16"
}
variable "request" {
  description = "Validated InfraForge request. Local terraform_data resources never call a cloud API."
  type        = any
}
resource "terraform_data" "network" {
  input = var.request
}
resource "terraform_data" "subnet" {
  for_each = toset(var.request.subnets)
  input    = { cidr = each.key, network = terraform_data.network.id }
}
resource "terraform_data" "firewall" {
  input = var.request.ingress
}
resource "terraform_data" "identity" {
  input = { actions = var.request.iam, encrypted = var.request.encrypted, tags = var.request.tags }
}
output "network" {
  value = terraform_data.network.output
}
resource "terraform_data" "compute" {
  count = try(var.request.compute, null) != null ? 1 : 0
  input = try(var.request.compute, null)
}
resource "terraform_data" "dns" {
  count = try(var.request.dns, null) != null ? 1 : 0
  input = try(var.request.dns, null)
}
resource "terraform_data" "load_balancer" {
  count = try(var.request.loadBalancer, null) != null ? 1 : 0
  input = try(var.request.loadBalancer, null)
}
