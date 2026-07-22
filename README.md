# xCatarina Timelapse Studio

Estúdio privado para criar timelapses MP4 H.264 em 1080p60, nos formatos 16:9 e 9:16, de pintura, arte e LEGO e publicá-los no arquivo público xCatarina.

## Importar diretamente uma VOD Twitch reservada a subs

O processamento de VODs longas corre localmente, porque uma função Vercel não pode permanecer ativa durante várias horas. A sessão e a palavra-passe da Twitch nunca são enviadas ao Studio: o helper entrega apenas a ligação HLS temporária que o player autorizado já está a usar.

1. Faz duplo clique em `start-studio-local.cmd` e mantém a janela aberta.
2. Abre `http://localhost:3000`.
3. Instala Tampermonkey no navegador e usa **Instalar helper** no Studio (só é necessário uma vez).
4. Cola a ligação da VOD e prime **Tentar importar**.
5. Na página Twitch que abre, inicia sessão se necessário e carrega no Play.
6. Quando aparecer **VOD ligada**, escolhe a duração e o intervalo e ajusta a moldura 9:16 sobre a live 16:9.
7. Prime **Gerar os 2 MP4 da VOD**. O Studio acelera todo o vídeo entre o início e o fim; não cria um slideshow.
8. Descarrega os dois MP4 ou usa **Publicar os 2 formatos juntos** para os guardar como uma única publicação no site público.

As três caixas de imagens são marcadores visuais opcionais. O horário da primeira imagem da live pode definir o início e o horário da última pode definir o fim, quando os campos do intervalo estão vazios. As imagens e os horários nunca são desenhados no vídeo. Uma terceira imagem que não seja da live fica apenas como referência.

O FFmpeg lê em sequência todos os segmentos HLS do intervalo e acelera o vídeo completo para a duração final. Não guarda uma cópia integral da VOD: ficam apenas os dois MP4 finais em `outputs/` e o pequeno ficheiro JSON de estado; playlists e imagens temporárias são apagadas no fim. A ligação autorizada é mantida apenas na memória do processo local e expira.

Ambos os formatos recebem uma marca de água discreta xCatarina/Twitch no canto inferior esquerdo. A versão horizontal tem 1920 × 1080 e a vertical 1080 × 1920, ambas a 60 fps.

Para publicar a partir de `localhost`, é necessário `BLOB_READ_WRITE_TOKEN` do mesmo Blob store usado pelo site público. O `start-studio-local.cmd` tenta carregá-lo automaticamente de `..\xcatarina\.env.local`, sem mostrar o valor no terminal. Se os projetos estiverem noutra estrutura, coloca o token em `xcatarina-private\.env.local`.

## Desenvolvimento

Requer Node.js 22 ou superior.

```bash
npm install
npm run dev
npm run build
```

O Vercel continua a alojar a interface privada e a publicação por IP. A importação direta de VOD e o FFmpeg são bloqueados no Vercel e só funcionam em `localhost`.
