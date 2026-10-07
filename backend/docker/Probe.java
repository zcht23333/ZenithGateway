import java.net.HttpURLConnection;
import java.net.URI;

public class Probe {
    public static void main(String[] args) {
        try {
            var connection = (HttpURLConnection) URI.create(args[0]).toURL().openConnection();
            connection.setConnectTimeout(2000);
            connection.setReadTimeout(2000);
            int status = connection.getResponseCode();
            connection.disconnect();
            System.exit(status == 200 ? 0 : 1);
        } catch (Exception unavailable) { System.exit(1); }
    }
}
