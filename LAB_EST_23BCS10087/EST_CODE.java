public class SocialMedia{
    public static void main(String[] args) {
        SocialMedia facebook = new Facebook();
        SocialMedia whatsapp = new Whatsapp();
        SocialMedia instagram = new Instagram();

        facebook.createPost();
        whatsapp.createPost();
        instagram.createPost();
    }

    public void createPost(){
        System.out.println("Creating a post...");
    }
}

class Facebook extends SocialMedia{
    @Override
    public void createPost(){
        System.out.println("Creating a post on Facebook...");
    }
}

class Whatsapp extends SocialMedia{
    @Override
    public void createPost(){
        System.out.println("Creating a post on Whatsapp...");
    }
}

class Instagram extends SocialMedia{
    @Override
    public void createPost(){
        System.out.println("Creating a post on Instagram...");
    }
}