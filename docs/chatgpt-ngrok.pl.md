# Blockbench MCP w ChatGPT przez ngrok

[English version](chatgpt-ngrok.md)

ChatGPT działa w chmurze i łączy się tylko z serwerami w internecie, a serwer wtyczki nasłuchuje wyłącznie na Twoim komputerze. Połączy je tunel [ngrok](https://ngrok.com/).

> [!WARNING]
> **Tunel wystawia serwer do internetu, a serwer nie ma hasła.** Każdy, kto do niego dotrze, może sterować Blockbench oraz czytać i zapisywać pliki w każdym miejscu dostępnym dla Blockbench. Wykonaj poniższe kroki dokładnie: chroni Cię tajny adres z kroku 2. Traktuj go jak hasło, a po skończonej pracy zamknij tunel.

> [!NOTE]
> Ta instrukcja opiera się na aktualnej dokumentacji OpenAI i ngrok, ale cała ścieżka przez ngrok i ChatGPT nie została jeszcze przetestowana. Jeśli któryś krok działa inaczej, [zgłoś to](https://github.com/sikorafranciszek/blockbench-mcp-addon/issues).

## Czego potrzebujesz

- Blockbench z działającą wtyczką. Zobacz [szybki start](../README.pl.md#szybki-start).
- Darmowe [konto ngrok](https://dashboard.ngrok.com/signup).
- ChatGPT w przeglądarce, na koncie z możliwością dodawania własnych serwerów MCP. Dokumentacja OpenAI nie wymienia planów i zaznacza, że obowiązują zasady obszaru roboczego, więc na koncie firmowym może to wymagać zgody administratora.

## 1. Zainstaluj ngrok

W systemie Windows:

```bash
winget install Ngrok.Ngrok
```

Na innych systemach skorzystaj ze [strony pobierania ngrok](https://ngrok.com/download). Następnie dodaj token z [panelu ngrok](https://dashboard.ngrok.com/get-started/your-authtoken):

```bash
ngrok config add-authtoken TWOJ_TOKEN
```

## 2. Utwórz tajny adres

Wygeneruj losową wartość i zachowaj ją na kolejne kroki.

W PowerShellu:

```powershell
[guid]::NewGuid().ToString('N')
```

Na macOS lub Linuksie:

```bash
openssl rand -hex 16
```

W głównym folderze repozytorium skopiuj plik [`docs/ngrok-policy.example.yml`](ngrok-policy.example.yml) jako `ngrok-policy.yml`. Zastąp `REPLACE_WITH_SECRET` swoją wartością w obu miejscach. Git ignoruje ten plik, więc sekret nie trafi do commita.

Jeśli zmieniono port wtyczki, zmień też `host` w polityce i port w kolejnym poleceniu.

## 3. Uruchom tunel

Uruchom to w głównym folderze repozytorium:

```bash
ngrok http 127.0.0.1:3939 --traffic-policy-file ngrok-policy.yml
```

ngrok pokaże wiersz `Forwarding` z Twoją domeną publiczną. Adres serwera to ta domena wraz z sekretem:

```text
https://TWOJA-DOMENA/TWOJ_SEKRET/mcp
```

## 4. Sprawdź tunel

W Windows PowerShell używaj `curl.exe` zamiast `curl`.

Tajny adres powinien zwrócić **405**. To prawidłowy wynik: żądanie dotarło do wtyczki, która pod tym adresem przyjmuje tylko POST.

```bash
curl -i https://TWOJA-DOMENA/TWOJ_SEKRET/mcp
```

Adres bez sekretu powinien zwrócić **404**. Jeśli zamiast tego dociera do wtyczki, zatrzymaj tunel i sprawdź plik polityki.

```bash
curl -i https://TWOJA-DOMENA/mcp
```

## 5. Dodaj serwer do ChatGPT

1. Otwórz [chatgpt.com/plugins](https://chatgpt.com/plugins).
2. Wybierz przycisk plusa, a potem **Add custom MCP server**.
3. Wpisz nazwę, np. `Blockbench`.
4. W sekcji **Connection** podaj jako adres serwera pełny adres z kroku 3.
5. W **Authentication** wybierz **No authentication**. Tę rolę pełni tajny adres.
6. Przeczytaj ostrzeżenie o ryzyku i wybierz **I understand and want to continue**.
7. Wybierz **Create as a plugin**, sprawdź, czy narzędzia się pojawiły, i zainstaluj wtyczkę.

OpenAI co jakiś czas zmienia te menu. Aktualne kroki znajdziesz w poradniku [dodawania własnego serwera MCP](https://developers.openai.com/api/docs/guides/custom-mcp-server).

## 6. Korzystaj

Blockbench i tunel muszą pozostać włączone. Rozpocznij nową rozmowę, wpisz `@`, wybierz swoją wtyczkę i o coś poproś:

> Zrób w Blockbench małą latarnię w stylu Minecrafta, w formacie java_block. Sprawdzaj podgląd po każdym etapie.

ChatGPT prosi o potwierdzenie każdego narzędzia, które coś zmienia. Narzędzia tylko do odczytu, np. podglądy, nie pytają. W ramach jednej rozmowy możesz zapamiętać decyzję dla danego narzędzia.

Dokumentacja OpenAI nie mówi, jak ChatGPT traktuje obrazy zwracane przez narzędzia. Jeśli ChatGPT nie reaguje na podglądy, sprawdzaj jego pracę na żywo w Blockbench i mów mu, co poprawić.

## Gdy skończysz

Naciśnij `Ctrl+C` w oknie ngrok, aby zamknąć tunel. Gdy tunel jest zamknięty, ChatGPT nie ma dostępu do Blockbench.

Jeśli tajny adres wycieknie, zmień wartość w `ngrok-policy.yml`, uruchom ngrok ponownie i zaktualizuj adres w ChatGPT.

## Bezpieczeństwo

- Ustawienie `MCP: Allow run_script` pozostaw **wyłączone**. Po jego włączeniu wyciek adresu pozwoliłby innym uruchamiać kod na Twoim komputerze.
- Zamykaj tunel, gdy z niego nie korzystasz.
- Czytaj każde potwierdzenie przed zatwierdzeniem, zwłaszcza dla narzędzi zapisujących lub eksportujących pliki. Strona lub plik, który czyta ChatGPT, może próbować nakłonić go do ich niewłaściwego użycia.
- Nigdy nie umieszczaj tego adresu na zrzutach ekranu, w repozytorium ani na publicznym czacie.
- ngrok może też ograniczyć dostęp do [publikowanych zakresów IP OpenAI](https://developers.openai.com/api/docs/guides/ip-addresses) za pomocą akcji [`restrict-ips`](https://ngrok.com/docs/traffic-policy/actions/restrict-ips). Te zakresy z czasem się zmieniają, a zabezpieczenie to uzupełnia tajny adres, ale go nie zastępuje.

## Rozwiązywanie problemów

| Problem | Co zrobić |
| --- | --- |
| W kroku 4 pojawia się **403** zamiast 405 | Żądanie dotarło do wtyczki, ale `host` w `ngrok-policy.yml` nie zgadza się z jej adresem i portem. |
| ngrok zgłasza błąd połączenia z serwerem lub zwraca 502 | Blockbench jest zamknięty albo wtyczka nie działa. Sprawdź `Tools > MCP Server`. |
| Oba adresy zwracają **404** | Sekret w pliku polityki różni się od tego w adresie. Sprawdź, czy zastąpiono go w obu miejscach. |
| ChatGPT dostaje stronę ostrzeżenia ngrok (`ERR_NGROK_6024`) | Darmowe konta pokazują ją przeglądarkom. Nie powinna wpływać na ruch API, a jeśli jednak wpływa, usuwa ją płatny plan ngrok. |
| ChatGPT nie pokazuje nowych narzędzi | Po aktualizacji wtyczki otwórz jej szczegóły w ChatGPT i odśwież ją. |
| Tunel przestaje działać | Darmowy plan ngrok ma [miesięczne limity](https://ngrok.com/docs/pricing-limits/free-plan-limits). Limit transferu najszybciej zużywają obrazy. |
