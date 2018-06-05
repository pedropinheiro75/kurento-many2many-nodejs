FROM node:9.11.1

RUN mkdir /src
WORKDIR /src

RUN npm install npm -g
RUN npm install -g bower

RUN git clone https://github.com/gnosis7bit/kurento-many2many-nodejs.git .

COPY entrypoint.sh /

RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

EXPOSE 8443