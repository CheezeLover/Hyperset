# Debian 12+
sudo apt update && sudo apt install -y podman podman-compose

# Check install
podman --version
podman-compose --version

# Allow unpriviledged ports
#sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80
#echo "net.ipv4.ip_unprivileged_port_start=80" | sudo tee /etc/sysctl.d/99-unprivileged-ports.conf

# Create the network
podman network create hyperset-net

# Build custom caddy image with caddy security
cd ~/Hyperset/Caddy
podman build -t hyperset-caddy:latest .

# Start Caddy
cd ~/Hyperset
podman-compose up -d

# Check logs
podman-compose logs -f
