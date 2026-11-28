# Bot de Resposta Automática WhatsApp — Negão Lanches

Aplicação web local desenvolvida em **Node.js + Express + Baileys + SQLite** para monitorar mensagens recebidas no WhatsApp do **Negão Lanches** e enviar respostas automáticas de atendimento, respeitando rigorosamente o horário permitido (**17h00 às 00h00** no fuso **America/Sao_Paulo**) e o limite de **1 resposta por número por dia**.

> **IMPORTANTE:** Este sistema **não realiza disparo em massa**. Ele responde exclusivamente de forma receptiva quando um cliente envia uma mensagem individual ao número conectado.
>
> **Aviso sobre conexão não oficial:** A integração utiliza a biblioteca Baileys (WhatsApp Web não oficial), sujeita a desconexões temporárias, necessidade de leitura de QR Code e eventuais restrições/políticas do WhatsApp.

---

## Principais Funcionalidades

- **Conexão por QR Code local:** Exibe o QR Code diretamente no painel web, salva a sessão localmente em `storage/auth/` (protegida e fora da pasta pública) e restaura a sessão automaticamente ao iniciar.
- **6 estados de conexão em tempo real:** `Desconectado`, `Aguardando leitura do QR Code`, `Conectando`, `Conectado`, `Reconectando` e `Erro de conexão`.
- **Regra diária automática:** Cada número recebe no máximo **1 resposta automática por dia por campanha**, com renovação automática à meia-noite (`00:00 America/Sao_Paulo`), sem reiniciar o servidor nem apagar histórico.
- **Janela de horário estrita (`17:00` às `00:00` — `America/Sao_Paulo`):** Mensagens fora do horário são registradas no histórico como `IGNORADO — FORA DO HORÁRIO` e nunca são enfileiradas para envio atrasado.
- **Prevenção atômica de duplicidade:** Transações SQLite (`BEGIN IMMEDIATE`) + restrição `UNIQUE (campanha_id, telefone, data_referencia)` na tabela `respostas_enviadas`.
- **Gerenciamento de campanhas e editor com pré-visualização:** Edite a mensagem padrão diretamente no painel mantendo quebras de linha.
- **Histórico persistente com filtros:** Filtre por data, telefone, campanha e status sem armazenar conteúdo das conversas particulares.
- **Proteção Opt-out:** Contatos que solicitarem interrupção (`SAIR`, `PARAR`, `CANCELAR`, etc.) ou bloqueados manualmente não recebem mensagens.

---

## Estrutura do Projeto

```text
ProjetoMensagemAutomatica/
├── server.js                      # Ponto de entrada, inicialização e desligamento seguro
├── package.json
├── .env.example
├── public/                        # Frontend (HTML, CSS, JS)
│   ├── index.html
│   ├── css/styles.css
│   └── js/app.js
├── src/
│   ├── app.js                     # Configuração do Express e cabeçalhos de segurança
│   ├── config/env.js              # Configurações, fuso horário e constantes
│   ├── database/db.js             # Banco SQLite (campanhas, respostas_enviadas, eventos)
│   ├── routes/api.js              # Rotas REST e stream SSE
│   └── services/
│       ├── timeService.js         # Cálculo de data/hora em America/Sao_Paulo
│       ├── campaignService.js     # Gestão de campanhas (1 ativa por vez)
│       ├── replyService.js        # Motor de resposta automática e controle de duplicidade
│       ├── whatsappService.js     # Gerenciador de conexão Baileys e filtro de mensagens
│       └── sseService.js          # Atualizações em tempo real no painel
└── tests/
    └── bot.test.js                # Suíte automatizada com todos os cenários obrigatórios
```

---

## Requisitos

- **Node.js 22.5+** (testado em Node.js v24)
- **npm**

---

## Como Executar Localmente

1. Instale as dependências:

```bash
npm install
```

2. *(Opcional)* Copie `.env.example` para `.env` caso queira definir uma chave de acesso para o painel (`PANEL_ACCESS_KEY`) ou ajustar a porta:

```bash
copy .env.example .env
```

3. Inicie o servidor:

```bash
npm start
```

4. Acesse no navegador:

```text
http://localhost:3000
```

5. Vá em **CONECTAR WHATSAPP**, aguarde o QR Code e escaneie pelo aplicativo do WhatsApp em **Dispositivos conectados > Conectar dispositivo**.

---

## Executar os Testes Automatizados

Para validar todas as regras de horário, virada de meia-noite, limite diário, persistência após reinício, concorrência, grupos e mensagens próprias:

```bash
npm test
```
