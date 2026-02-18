# Debian 12+
sudo apt update && sudo apt install -y podman podman-compose

# Install python libs
#sudo apt install python3-pip
#pip3 install psycopg2-binary

# Check install
podman --version
podman-compose --version

# Allow unpriviledged ports > OLD
#sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80
#echo "net.ipv4.ip_unprivileged_port_start=80" | sudo tee /etc/sysctl.d/99-unprivileged-ports.conf

# Create the network
podman network create hyperset-net

# Build custom caddy image with caddy security
cd ~/Hyperset/Caddy
podman build -t hyperset-caddy:latest .

# Build custom image of Superset
#cd ~/Hyperset/Superset
#podman-compose build superset

# Start Caddy
cd ~/Hyperset
podman-compose up -d

# Check logs
podman-compose logs -f
