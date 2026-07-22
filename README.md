# xCatarina Timelapse Studio

Estúdio privado para criar timelapses 16:9 e 9:16 de pintura, arte e LEGO e publicá-los no arquivo público xCatarina.

## Importar diretamente uma VOD Twitch reservada a subs

O processamento de VODs longas corre localmente, porque uma função Vercel não pode permanecer ativa durante várias horas. A sessão e a palavra-passe da Twitch nunca são enviadas ao Studio: o helper entrega apenas a ligação HLS temporária que o player autorizado já está a usar.

1. Faz duplo clique em `start-studio-local.cmd` e mantém a janela aberta.
2. Abre `http://localhost:3000`.
3. Instala Tampermonkey no navegador e usa **Instalar helper** no Studio (só é necessário uma vez).
4. Cola a ligação da VOD e prime **Tentar importar**.
5. Na página Twitch que abre, inicia sessão se necessário e carrega no Play.
6. Quando aparecer **VOD ligada**, escolhe a duração/intervalo e gera os dois formatos.

As saídas MP4 são guardadas em `outputs/`, que não é sincronizada com Git. A ligação autorizada é mantida apenas na memória do processo local e expira.

Para VODs longas, o Studio não transfere a emissão completa: seleciona segmentos HLS distribuídos por todo o intervalo e cria simultaneamente as versões 16:9 e 9:16 numa única passagem do FFmpeg. O estado do processamento indica quantos segmentos foram escolhidos.

## Desenvolvimento

Requer Node.js 22 ou superior.

```bash
npm install
npm run dev
npm run build
```

O Vercel continua a alojar a interface privada e a publicação por IP. A importação direta de VOD e o FFmpeg são bloqueados no Vercel e só funcionam em `localhost`.
